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
const costTransmitterBillToNbrs = process.env.COST_TRANSMITTER_BILL_TO_NUMBER.split(',');

module.exports.handler = async (event, context) => {
  try {
    console.info('Event: ', event);

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
    console.info('Log Id: ', get(dynamoData, 'Id'));

    const newImage = AWS.DynamoDB.Converter.unmarshall(get(message, 'NewImage', {}));
    orderNo = get(newImage, 'FK_OrderNo', '');
    dynamoData.OrderNo = orderNo;
    dynamoData.SeqNo = get(newImage, 'SeqNo', '');

    const shipmentId = await getShipmentId(orderNo, get(newImage, 'SeqNo', ''));
    if (!shipmentId) {
      return;
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
    let message = `An error occurred in function ${context.functionName}.\n\n
    ERROR DETAILS: ${errorMsgVal}.\n\n
    Id: ${get(dynamoData, 'Id', '')}.\n\n
    FileNumber: ${orderNo}. \n\n
    This is a process to send the cost line for each CW shipment to CW system.\n\n
    Note: Use the id: ${get(dynamoData, 'Id', '')} for better search in the logs and also check in dynamodb: ${process.env.LOGS_TABLE} for understanding the complete data.`;
    await publishToSNS({
      message,
      subject: `Omni WT CW Cost Transmitter Integration Error for OrderNo: ${orderNo} `,
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
        ':status': 'SUCCESS'
      },
    };
    const logsResult = await dbQuery(logParams);
    console.info('logsResult: ', logsResult);
    if (logsResult.length > 0) {
      console.info('Shipment is already sent to CW.')
      return false;
    }

    const headerParams = {
      TableName: process.env.SHIPMENT_HEADER_TABLE,
      KeyConditionExpression: 'PK_OrderNo = :PK_OrderNo',
      ExpressionAttributeValues: {
        ':PK_OrderNo': orderNo,
      },
    };
    const headerData = await dbQuery(headerParams);
    console.info('header data: ', headerData);

    if (!costTransmitterBillToNbrs.includes(get(headerData, '[0].BillNo'))) {
      console.info('This event is not related to lenovo. So, skipping the process.');
      return false;
    }
    dynamoData.BillToNbr = get(headerData, '[0].BillNo')

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
                <Code>TRL</Code> 
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
