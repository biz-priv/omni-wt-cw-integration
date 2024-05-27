'use strict';

const AWS = require('aws-sdk');
const { get, includes } = require('lodash');
const axios = require('axios');
const xml2js = require('xml2js');
const moment = require('moment-timezone');
const { dbQuery, putItem, publishToSNS } = require('../../shared/dynamo');
const { xmlToJson, cstDateTime, STATUSES } = require('../../shared/helper');

const lenovoCustomerId = '17773';
const allowedMilestones = ['PUP', 'TTC', 'DEL'];

module.exports.handler = async (event, context) => {
  try {
    console.info('🚀 ~ file: index.js:15 ~ module.exports.handler= ~ event:', event);
    const record = get(event, 'Records[0]', {});
    const recordBody = JSON.parse(get(record, 'body', ''));
    const message = JSON.parse(get(recordBody, 'Message', ''));
    console.info('🚀 ~ file: index.js:22 ~ module.exports.handler= ~ message:', message);

    const oldImage = get(message, 'OldImage', '');
    if (oldImage !== '') {
      console.info('Skipped as this is an update or delete shipment.');
      return;
    }

    if (
      get(message, 'dynamoTableName', '') === `omni-wt-rt-shipment-milestone-${process.env.STAGE}`
    ) {
      console.info(message);
      const data = AWS.DynamoDB.Converter.unmarshall(get(message, 'NewImage', {}));
      const orderNo = get(data, 'FK_OrderNo', '');
      const orderStatusId = get(data, 'FK_OrderStatusId', '');
      const eventDateTime = get(data, 'EventDateTime');

      console.info('Order Status ID:', orderStatusId);
      console.info('Event DateTime:', eventDateTime);

      if (eventDateTime.includes('1900')) {
        console.info('Skipping the record as the eventDateTime is invalid');
        return;
      }

      const formattedDateTime = moment(eventDateTime).format('YYYY-MM-DDTHH:mm:ss');
      console.info('Formatted DateTime:', formattedDateTime);

      if (!includes(allowedMilestones, orderStatusId)) {
        console.info('Skipped as this is not a valid milestone.');
        return;
      }

      const headerParams = {
        TableName: process.env.SHIPMENT_HEADER_TABLE,
        KeyConditionExpression: 'PK_OrderNo = :orderNo',
        FilterExpression: 'ShipQuote = :shipquote AND BillNo = :billno',
        ExpressionAttributeValues: {
          ':orderNo': orderNo,
          ':shipquote': 'S',
          ':billno': lenovoCustomerId,
        },
      };

      const referenceParams = {
        TableName: process.env.REFERENCE_TABLE,
        IndexName: process.env.REFERENCE_TABLE_INDEX,
        KeyConditionExpression: 'FK_OrderNo = :orderno',
        FilterExpression: 'CustomerType = :customertype AND FK_RefTypeId = :reftype',
        ExpressionAttributeValues: {
          ':orderno': orderNo,
          ':customertype': 'B',
          ':reftype': 'SID',
        },
      };

      const [shipmentHeaderResult, referencesResult] = await Promise.all([
        dbQuery(headerParams),
        dbQuery(referenceParams),
      ]);

      if (shipmentHeaderResult.length === 0) {
        console.info(
          `No data found in ${process.env.SHIPMENT_HEADER_TABLE} table for FK_OrderNo: ${orderNo}.`
        );
        return;
      }

      if (referencesResult.length === 0) {
        throw new Error(
          `No data found in ${process.env.REFERENCE_TABLE} table for FK_OrderNo: ${orderNo}.`
        );
      }
      const housebill = get(shipmentHeaderResult, '[0].Housebill');
      console.info('Housebill:', housebill);

      const referenceNo = get(referencesResult, '[0].ReferenceNo', '');
      console.info('Reference No:', referenceNo);

      const cwPayload = await payloadToCW(referenceNo, formattedDateTime, orderStatusId);
      console.info('Payload:', cwPayload);

      const xmlCWResponse = await sendToCW(cwPayload);
      console.info('CW Response:', xmlCWResponse);

      const xmlCWObjResponse = await xmlToJson(xmlCWResponse);
      validateCWResponse(xmlCWObjResponse);

      await putItem({
        tableName: process.env.STATUS_TABLE,
        item: {
          OrderNo: orderNo,
          OrderStatusId: orderStatusId,
          ReferenceNo: referenceNo,
          Status: STATUSES.SENT,
          EventDateTime: formattedDateTime,
          Payload: cwPayload,
          Response: xmlCWResponse,
          InsertedTimeStamp: cstDateTime,
        },
      });
    }
  } catch (error) {
    console.error('Error in handler:', error);
    await handleError(error, context, event);
    throw error;
  }
};

async function payloadToCW(referenceNo, eventDateTime, orderStatusId) {
  try {
    const builder = new xml2js.Builder({
      headless: true,
      renderOpts: { pretty: true, indent: '    ' },
    });

    const xmlData = {
      UniversalEvent: {
        $: {
          xmlns: 'http://www.cargowise.com/Schemas/Universal/2011/11',
          version: '1.1',
        },
        Event: {
          DataContext: {
            DataTargetCollection: {
              DataTarget: {
                Type: 'ForwardingShipment',
                Key: referenceNo,
              },
            },
          },
          EventTime: eventDateTime,
          EventType: ['TTC', 'PUP'].includes(orderStatusId) ? 'PCF' : 'DCF',
          IsEstimate: 'false',
        },
      },
    };

    return builder.buildObject(xmlData);
  } catch (error) {
    console.error('Error in trackingShipmentPayload:', error);
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

    console.info('config:', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    throw new Error(`CARGOWISE API Request Failed: ${res}`);
  } catch (error) {
    console.error('CARGOWISE API Request Failed:', error);
    throw error;
  }
}

const validateCWResponse = (response) => {
  const EventType = get(response, 'UniversalResponse.Data.UniversalEvent.Event.EventType', '');
  const contentType =
    get(
      response,
      'UniversalResponse.Data.UniversalEvent.Event.ContextCollection.Context',
      []
    ).filter((obj) => obj.Type === 'ProcessingStatusCode')[0]?.Value || '';

  if (EventType !== 'DIM' || contentType !== 'PRS') {
    throw new Error(
      `CARGOWISE API call failed: ${get(response, 'UniversalResponse.ProcessingLog', '')}`
    );
  }
};

const handleError = async (error, context, event) => {
  console.error('Error:', error);
  const record = get(event, 'Records[0]', {});
  const recordBody = JSON.parse(get(record, 'body', ''));
  const message = JSON.parse(get(recordBody, 'Message', ''));
  const data = AWS.DynamoDB.Converter.unmarshall(get(message, 'NewImage', {}));
  const orderNo = get(data, 'FK_OrderNo', '');
  const orderStatusId = get(data, 'FK_OrderStatusId', '');

  try {
    await sendSNSNotification(context, error, orderNo, orderStatusId);
    console.info('SNS notification has been sent');
  } catch (snsError) {
    console.error('Error while sending SNS notification:', snsError);
  }

  const ErrorMsg = `${error.message}`;
  await putItem({
    tableName: process.env.STATUS_TABLE,
    item: {
      OrderNo: orderNo,
      OrderStatusId: orderStatusId,
      Status: STATUSES.FAILED,
      ErrorMsg,
      InsertedTimeStamp: cstDateTime,
    },
  });
};

const sendSNSNotification = (context, error, orderNo, orderStatusId) =>
  publishToSNS({
    message: `Error in ${context.functionName}.\n\nOrderNo: ${orderNo}.\n\nOrderStatusId: ${orderStatusId}.\nError Details: ${error.message}.`,
    subject: `LENOVO ADD MILESTONE ERROR ~ OrderNo: ${orderNo} / OrderStatusId: ${orderStatusId}`,
  });
