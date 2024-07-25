'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');
const axios = require('axios');
const { dbQuery, publishToSNS, putItem } = require('../shared/dynamo');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { xmlToJson } = require('../shared/helper');

const dynamoData = {};
let orderNo;

module.exports.handler = async (event, context) => {
  try {
    console.info('module.exports.handler= -> event:', event);

    //hardcoding to 0th index as we will receive only one event for this lambda.
    const record = get(event, 'Records[0]', []);

    const recordBody = JSON.parse(get(record, 'body', {}));
    const message = JSON.parse(get(recordBody, 'Message', {}));

    // Set the time zone to CST
    const cstDate = moment().tz('America/Chicago');
    dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
    dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
    dynamoData.Event = record;
    dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
    console.info('module.exports.handler= -> Log Id:', dynamoData.Id);

    const newImage = AWS.DynamoDB.Converter.unmarshall(get(message, 'NewImage', {}));
    orderNo = get(newImage, 'FK_OrderNo', '');
    dynamoData.OrderNo = orderNo;
    dynamoData.SeqNo = get(newImage, 'SeqNo', '');

    const shipmentId = await getShipmentId(orderNo);
    if (!shipmentId) {
      return false;
    }
    dynamoData.ShipmentId = shipmentId;

    const xmlCWPayload = await prepareCwPayload(shipmentId, get(newImage, 'Total', ''));
    console.info(xmlCWPayload);

    dynamoData.XmlCWPayload = xmlCWPayload;
    const xmlCWResponse = await sendToCW(xmlCWPayload);
    console.info(xmlCWResponse);
    dynamoData.XmlCWResponse = xmlCWResponse;

    const xmlCWObjResponse = await xmlToJson(xmlCWResponse);

    const EventType = get(
      xmlCWObjResponse,
      'UniversalResponse.Data.UniversalEvent.Event.EventType',
      ''
    );
    const contentType = get(
      get(
        xmlCWObjResponse,
        'UniversalResponse.Data.UniversalEvent.Event.ContextCollection.Context',
        []
      ).filter((obj) => obj.Type === 'ProcessingStatusCode'),
      '[0].Value',
      ''
    );

    console.info('EventType: ', EventType, 'contentType', contentType);

    if (EventType !== 'DIM' && (contentType === 'DCD' || contentType === 'REJ')) {
      throw new Error(
        `CARGOWISE API call failed: ${get(xmlCWObjResponse, 'UniversalResponse.ProcessingLog', '')}`
      );
    }

    dynamoData.Status = 'SUCCESS';
    await putItem({ tableName: process.env.LOGS_TABLE, item: dynamoData });
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          responseId: get(dynamoData, 'Id', ''),
          Message: 'Success',
        },
        null,
        2
      ),
    };
  } catch (error) {
    console.error('Main handler error: ', error);

    let errorMsgVal = '';
    if (get(error, 'message', null) !== null) {
      errorMsgVal = get(error, 'message', '');
    } else {
      errorMsgVal = error;
    }
    await sendSESEmail({
      message: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: Arial, sans-serif;
          }
          .container {
            padding: 20px;
            border: 1px solid #ddd;
            border-radius: 5px;
            background-color: #f9f9f9;
          }
          .highlight {
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <p>Dear Team,</p>
          <p>Error while trasmitting the cost:</p>
          <p><span class="highlight">Error:</span> <strong>${errorMsgVal}</strong><br>
             <span class="highlight">ID:</span> <strong>${get(dynamoData, 'Id', '')}</strong><br>
             <span class="highlight">Shipment ID:</span> <strong>${get(dynamoData, 'ShipmentId', '')}</strong><br>
             <span class="highlight">File No:</span> <strong>${get(dynamoData, 'OrderNo', '')}</strong></p>
             <span class="highlight">SeqNo:</span> <strong>${get(dynamoData, 'SeqNo', '')}</strong></p>
          <p>Thank you,<br>
          Omni Automation System</p>
          <p style="font-size: 0.9em; color: #888;">Note: This is a system generated email, Please do not reply to this email.</p>
        </div>
      </body>
      </html>
      `,
      subject: `${upperCase(process.env.STAGE)} - Lenovo Cost Transmitter: File No: ${get(dynamoData, 'OrderNo', '')} | Shipment ID ${get(dynamoData, 'ShipmentId', '')}.`,
    });
    dynamoData.ErrorMsg = errorMsgVal;
    dynamoData.Status = 'FAILED';
    await putItem({ tableName: process.env.LOGS_TABLE, item: dynamoData });
    return {
      statusCode: 400,
      body: JSON.stringify(
        {
          responseId: dynamoData.Id,
          message: error,
        },
        null,
        2
      ),
    };
  }
};

async function getShipmentId(orderNo, seqNo) {
  try {
    const headerParams = {
      TableName: process.env.SHIPMENT_HEADER_TABLE,
      KeyConditionExpression: 'PK_OrderNo = :PK_OrderNo',
      ExpressionAttributeValues: {
        ':PK_OrderNo': orderNo,
      },
    };
    const headerData = await dbQuery(headerParams);
    console.info('header data: ', headerData);

    const customerListParams = {
      TableName: process.env.CUSTOMER_LIST_TABLE,
      KeyConditionExpression: 'BillNo = :BillNo',
      ExpressionAttributeValues: {
        ':BillNo': get(headerData, '[0].BillNo', ''),
      },
    };
    const customerListData = await dbQuery(customerListParams);
    console.info('customerListData: ', customerListData);
    if(customerListData === 0 || get(customerListData, '[0].TransmitCost', false) === false || get(customerListData, '[0].TransmitCost', 'false') === 'false'){
        console.info('The customer of this shipment is not listed to send the cost to CW.')
        return false;
    }

    dynamoData.BillToNbr = get(headerData, '[0].BillNo', '');

    const Params = {
      TableName: process.env.CREATE_SHIPMENT_LOGS_TABLE,
      IndexName: 'Housebill-index',
      KeyConditionExpression: 'Housebill = :Housebill',
      FilterExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'Status',
      },
      ExpressionAttributeValues: {
        ':Housebill': get(headerData, '[0].Housebill'),
        ':status': 'SUCCESS',
      },
    };

    const createShipmentLogsResults = await dbQuery(Params);
    console.info(createShipmentLogsResults);
    if (createShipmentLogsResults.length === 0) {
      console.info(`SKIPPING, This order No: ${orderNo} is not created from our integration.`);
      return false;
    }

    const logParams = {
      TableName: process.env.LOGS_TABLE,
      KeyConditionExpression: 'OrderNo = :OrderNo AND SeqNo = :SeqNo',
      FilterExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'Status',
      },
      ExpressionAttributeValues: {
        ':OrderNo': orderNo,
        ':SeqNo': seqNo,
        ':status': 'SUCCESS',
      },
    };
    const logsResult = await dbQuery(logParams);
    console.info('logsResult: ', logsResult);
    if (logsResult.length > 0) {
      console.info('Shipment is already sent to CW.');
      return false;
    }

    return get(createShipmentLogsResults, '[0].ShipmentId', '');
  } catch (error) {
    console.error('Error while fetching shipment Id: ', error);
    throw error;
  }
}

async function prepareCwPayload(shipmentId, amount) {
  try {
    return `<UniversalShipment xmlns:ns0="http://www.cargowise.com/Schemas/Universal/2011/11">
    <Shipment xmlns="http://www.cargowise.com/Schemas/Universal/2011/11">
        <DataContext>
            <DataTargetCollection>
                <DataTarget>
                    <Type>ForwardingShipment</Type>
                    <Key>${shipmentId}</Key>
                </DataTarget>
            </DataTargetCollection>
            <Company>
                <Code>ELP</Code> 
            </Company>
            <EnterpriseID>TRX</EnterpriseID>
            <ServerID>TS3</ServerID>
        </DataContext>
        <JobCosting>
            <ChargeLineCollection>
                <ChargeLine>
                    <Branch>
                        <Code>LCK</Code>
                    </Branch>
                    <ChargeCode>
                        <Code>FRT</Code>
                    </ChargeCode>
                    <Creditor>
                        <Type>Organization</Type>
                        <Key>ICLCK</Key>
                    </Creditor>
                    <CostRatingBehaviour>
                        <Code>REA</Code>
                    </CostRatingBehaviour>
                    <SellRatingBehaviour>
                        <Code>REA</Code>
                    </SellRatingBehaviour>
                    <Department>
                        <Code>FEA</Code>
                    </Department>
                    <ImportMetaData>
                        <Instruction>UpdateAndInsertIfNotFound</Instruction>
                        <MatchingCriteriaCollection>
                            <MatchingCriteria>
                                <FieldName>ChargeCode</FieldName>
                                <Value>FRT</Value>
                            </MatchingCriteria>
                            <MatchingCriteria>
                                <FieldName>Description</FieldName>
                                <Value>Freight</Value>
                            </MatchingCriteria>
                        </MatchingCriteriaCollection>
                    </ImportMetaData>
                    <CostOSAmount>${amount}</CostOSAmount>
                    <SellOSAmount></SellOSAmount>
                </ChargeLine>
            </ChargeLineCollection>
        </JobCosting>
    </Shipment>
</UniversalShipment>`;
  } catch (error) {
    console.error('Error while preparing the payload');
    throw error;
  }
}

async function sendToCW(postData) {
  try {
    const config = {
      url: process.env.CW_URL,
      method: 'post',
      headers: {
        Authorization: process.env.CW_ENDPOINT_AUTHORIZATION,
      },
      data: postData,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    throw new Error(`\n\nCARGOWISE API Request Failed: ${res}`);
  } catch (error) {
    const errorMsg = get(error, 'response.data', error.message);
    throw new Error(`${errorMsg}\n Payload: ${postData}`);
  }
}
