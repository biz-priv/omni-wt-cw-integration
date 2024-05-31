'use strict';

const AWS = require('aws-sdk');
const { get, includes, isEmpty } = require('lodash');
const axios = require('axios');
const xml2js = require('xml2js');
const moment = require('moment-timezone');
const { dbQuery, putItem, publishToSNS, getDynamoUpdateParam } = require('../../shared/dynamo');
const { xmlToJson, cstDateTime, STATUSES } = require('../../shared/helper');

const dynamoDB = new AWS.DynamoDB.DocumentClient();

const lenovoCustomerId = '17773';
const allowedMilestones = ['PUP', 'TTC', 'DEL'];

const checkExistingRecord = async (orderNo, orderStatusId) => {
  const statusParams = {
    TableName: process.env.STATUS_TABLE,
    KeyConditionExpression: 'OrderNo = :orderNo AND OrderStatusId = :orderStatusId',
    ExpressionAttributeValues: {
      ':orderNo': orderNo,
      ':orderStatusId': orderStatusId,
    },
  };

  const recordExisting = await dbQuery(statusParams);
  return recordExisting.length > 0 && recordExisting[0].Status === STATUSES.SENT;
};
module.exports.handler = async (event, context) => {
  try {
    console.info('🚀 ~ file: index.js:15 ~ module.exports.handler= ~ event:', event);
    const record = get(event, 'Records[0]', {});
    const recordBody = JSON.parse(get(record, 'body', ''));
    const message = JSON.parse(get(recordBody, 'Message', ''));
    console.info('🚀 ~ file: index.js:22 ~ module.exports.handler= ~ message:', message);

    const dynamoTableName = get(message, 'dynamoTableName', '');

    if (dynamoTableName === `omni-wt-rt-shipment-milestone-${process.env.STAGE}`) {
      await handleShipmentMilestone(message);
    } else if (dynamoTableName === `omni-wt-rt-apar-failure-${process.env.STAGE}`) {
      await handleAparFailure(message);
    }
  } catch (error) {
    console.error('Error in handler:', error);
    await handleError(error, context, event);
    throw error;
  }
};

const handleShipmentMilestone = async (message) => {
  const newImage = get(message, 'NewImage', {});
  const oldImage = get(message, 'OldImage', undefined);
  const data = AWS.DynamoDB.Converter.unmarshall(newImage);
  const orderNo = get(data, 'FK_OrderNo', '');
  const orderStatusId = get(data, 'FK_OrderStatusId', '');
  const eventDateTime = get(data, 'EventDateTime');
  const oldEventDateTime = oldImage ? get(AWS.DynamoDB.Converter.unmarshall(oldImage), 'EventDateTime') : null;

  if (oldEventDateTime === eventDateTime) {
    const isRecordSent = await checkExistingRecord(orderNo, orderStatusId);
    if (isRecordSent) {
      console.info(`Record with OrderNo: ${orderNo} and OrderStatusId: ${orderStatusId} already sent.`);
      return;
    }
  }

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

  const [shipmentHeaderResult, referencesResult] = await Promise.all([dbQuery(headerParams), dbQuery(referenceParams)]);

  if (isEmpty(shipmentHeaderResult)) {
    console.info(`No data found in ${process.env.SHIPMENT_HEADER_TABLE} table for FK_OrderNo: ${orderNo}.`);
    return;
  }

  if (isEmpty(referencesResult)) {
    throw new Error(`No data found in ${process.env.REFERENCE_TABLE} table for FK_OrderNo: ${orderNo}.`);
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
};

const handleAparFailure = async (message) => {
  const newImage = get(message, 'NewImage', {});
  const data = AWS.DynamoDB.Converter.unmarshall(newImage);
  const orderNo = get(data, 'FK_OrderNo', '');
  console.info('🚀 ~ file: index.js:151 ~ module.exports.handler= ~ orderNo:', orderNo);
  const fdCode = get(data, 'FDCode', '');
  console.info('🚀 ~ file: index.js:159 ~ module.exports.handler= ~ fdCode:', fdCode);
  const lenovoException = getLenovoException(fdCode);
  console.info('🚀 ~ file: index.js:161 ~ module.exports.handler= ~ lenovoException:', lenovoException);
  const lenovoCode = get(lenovoException, 'lenovoCode');
  console.info('🚀 ~ file: test.js:3074 ~ lenovoCode:', lenovoCode);
  const description = get(lenovoException, 'description');
  console.info('🚀 ~ file: test.js:3074 ~ lenovoCode:', description);

  if (lenovoCode === 'Unknown' || isEmpty(lenovoCode)) {
    console.info(`For fdCode: ${fdCode} the lenovo exception code is missing. Skipping the process`);
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

  const [shipmentHeaderResult, referencesResult] = await Promise.all([dbQuery(headerParams), dbQuery(referenceParams)]);

  if (isEmpty(shipmentHeaderResult)) {
    console.info(`No data found in ${process.env.SHIPMENT_HEADER_TABLE} table for FK_OrderNo: ${orderNo}.`);
    return;
  }

  if (isEmpty(referencesResult)) {
    throw new Error(`No data found in ${process.env.REFERENCE_TABLE} table for FK_OrderNo: ${orderNo}.`);
  }

  const housebill = get(shipmentHeaderResult, '[0].Housebill');
  console.info('Housebill:', housebill);

  const referenceNo = get(referencesResult, '[0].ReferenceNo', '');
  console.info('Reference No:', referenceNo);

  const trackingParams = {
    TableName: process.env.TRACKING_NOTES_TABLE,
    IndexName: process.env.TRACKING_NOTES_ORDERNO_INDEX,
    KeyConditionExpression: 'FK_OrderNo = :orderNo',
    FilterExpression: 'contains(Note, :failure)',
    ExpressionAttributeValues: {
      ':orderNo': orderNo,
      ':failure': 'Customer Service Failure',
    },
  };

  const trackingResult = await dbQuery(trackingParams);
  if (isEmpty(trackingResult)) {
    throw new Error(`No data found in ${process.env.TRACKING_NOTES_TABLE} table for FK_OrderNo: ${orderNo}.`);
  }

  const dateTimeEntered = get(trackingResult, 'DateTimeEntered');
  const formattedDateTime = moment(dateTimeEntered).format('YYYY-MM-DDTHH:mm:ss');
  console.info('Formatted DateTime:', formattedDateTime);

  const cwPayload = await payloadToCWforDelays(referenceNo, lenovoCode, description);
  console.info('🚀 ~ file: index.js:240 ~ module.exports.handler= ~ payloadToCW:', cwPayload);
  const xmlCWResponse = await sendToCW(cwPayload);
  console.info('CW Response:', xmlCWResponse);

  const xmlCWObjResponse = await xmlToJson(xmlCWResponse);
  validateCWResponse(xmlCWObjResponse);

  await putItem({
    tableName: process.env.STATUS_TABLE,
    item: {
      OrderNo: orderNo,
      OrderStatusId: fdCode,
      ReferenceNo: referenceNo,
      Status: STATUSES.SENT,
      EventDateTime: formattedDateTime,
      Payload: cwPayload,
      Response: xmlCWResponse,
      InsertedTimeStamp: cstDateTime,
    },
  });
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

async function payloadToCWforDelays(referenceNo, lenovoCode, description) {
  try {
    const builder = new xml2js.Builder({
      headless: true,
      renderOpts: { pretty: true, indent: '    ' },
    });

    const xmlData = {
      UniversalShipment: {
        $: {
          'xmlns:ns0': 'http://www.cargowise.com/Schemas/Universal/2011/11',
        },
        Shipment: {
          $: {
            xmlns: 'http://www.cargowise.com/Schemas/Universal/2011/11',
          },
          DataContext: {
            DataTargetCollection: {
              DataTarget: {
                Type: 'ForwardingShipment',
                Key: referenceNo,
              },
            },
          },
          NoteCollection: {
            $: {
              Content: 'Partial',
            },
            Note: {
              Description: 'Client Visible Job Notes',
              IsCustomDescription: 'false',
              NoteText: `${lenovoCode}-${description}`,
              NoteContext: {
                Code: 'AAA',
              },
            },
          },
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
  let orderStatusId;
  if (
    get(message, 'dynamoTableName', '') === `omni-wt-rt-shipment-milestone-${process.env.STAGE}`
  ) {
    orderStatusId = get(data, 'FK_OrderStatusId', '');
  } else {
    orderStatusId = 'Delays';
  }

  try {
    await sendSNSNotification(context, error, orderNo, orderStatusId);
    console.info('SNS notification has been sent');
  } catch (snsError) {
    console.error('Error while sending SNS notification:', snsError);
  }

  const errorMsg = `${error.message}`;
  await updateItem({
    tableName: process.env.STATUS_TABLE,
    key: { OrderNo: orderNo, OrderStatusId: orderStatusId },
    attributes: {
      Status: STATUSES.FAILED,
      ErrorMsg: errorMsg,
      InsertedTimeStamp: cstDateTime,
    },
  });
};

async function updateItem({ tableName, key, attributes }) {
  const { ExpressionAttributeNames, ExpressionAttributeValues, UpdateExpression } =
    getDynamoUpdateParam(attributes);

  const params = {
    TableName: tableName,
    Key: key,
    UpdateExpression,
    ExpressionAttributeNames,
    ExpressionAttributeValues,
  };

  try {
    return await dynamoDB.update(params).promise();
  } catch (e) {
    console.error('Update Item Error: ', e, '\nUpdate params: ', params);
    throw new Error('UpdateItemError');
  }
}
const sendSNSNotification = (context, error, orderNo, orderStatusId) =>
  publishToSNS({
    message: `Error in ${context.functionName}.\n\nOrderNo: ${orderNo}.\n\nOrderStatusId: ${orderStatusId}.\nError Details: ${error.message}.`,
    subject: `LENOVO ADD MILESTONE ERROR ~ OrderNo: ${orderNo} / OrderStatusId: ${orderStatusId}`,
  });

const exceptionMapping = {
  ADE: { lenovoCode: 'C05', description: 'EXPEDITE DELIVERY, EARLY ARRIVAL' },
  APP: { lenovoCode: 'A1', description: 'MISSED DELIVERY' },
  BADDA: { lenovoCode: 'A51', description: 'CARRIER KEYING ERROR' },
  CAN: { lenovoCode: 'CO', description: 'ORDER CANCELLED BY CUSTOMER' },
  CAR: { lenovoCode: 'A91', description: 'MISSED DELIVERY-CARRIER ERROR' },
  CHO: { lenovoCode: 'A42', description: 'HOLIDAY - CLOSED' },
  CON: { lenovoCode: 'AG', description: 'CONSIGNEE RELATED' },
  COS: { lenovoCode: 'S1', description: 'DAMAGED - DELIVERY NOT COMPLETED' },
  CRD: { lenovoCode: 'B02', description: 'APPOINTMENT OR PRE-ARRANGED DELIVERY DATE' },
  CUP: { lenovoCode: 'AJ', description: 'OTHER CARRIER RELATED' },
  CUS: { lenovoCode: 'A40', description: 'SHIPPER RELATED' },
  CUST: { lenovoCode: 'A40', description: 'SHIPPER RELATED' },
  DAM: { lenovoCode: 'A10', description: 'DAMAGED - DELIVERY NOT COMPLETED' },
  DEL: { lenovoCode: 'A33', description: 'OTHER CARRIER RELATED' },
  DLE: { lenovoCode: 'S01', description: 'INCOMPLETE DELIVERY' },
  FAOUT: {
    lenovoCode: 'FOI',
    description: '3PL OPS/NETWORK RELATED PROBLEM (FORWARDER ORIGIN ISSUE)',
  },
  FTUSP: { lenovoCode: 'I01', description: '3PL EDI ISSUE' },
  HUB: { lenovoCode: 'A33', description: 'OTHER CARRIER RELATED' },
  ICC: { lenovoCode: 'AQ', description: 'RECIPIENT UNAVAILABLE-DELIVERY DELAYED' },
  INCOM: { lenovoCode: 'A13', description: 'OTHER' },
  INMIL: { lenovoCode: 'A51', description: 'CARRIER KEYING ERROR' },
  INS: { lenovoCode: 'A13', description: 'OTHER' },
  IRRSL: { lenovoCode: 'A92', description: 'EXCEEDS SERVICE LIMITATION' },
  LAD: { lenovoCode: 'B08', description: 'IMPROPER UNLOADING FACILITY OR EQUIPMENT' },
  LATEB: { lenovoCode: 'AW', description: 'PAST CUT-OFF TIME' },
  LOST: { lenovoCode: 'A5', description: 'UNABLE TO LOCATE' },
  LPU: { lenovoCode: 'SOS', description: 'ODM/PLANT/MANUFACTURING LATE HANDOVER' },
  MI: { lenovoCode: 'A30', description: 'MECHANICAL BREAKDOWN' },
  MISC: { lenovoCode: 'BG', description: 'OTHER' },
  MISCU: { lenovoCode: 'A95', description: 'PAST CUT-OFF TIME' },
  MISS: { lenovoCode: 'A5', description: 'UNABLE TO LOCATE' },
  MTT: { lenovoCode: 'A33', description: 'OTHER CARRIER RELATED' },
  NTDT: { lenovoCode: 'P01', description: 'PROCESSING DELAY' },
  OLHNC: { lenovoCode: 'AW', description: 'PAST CUT-OFF TIME' },
  OLHNF: { lenovoCode: 'A33', description: 'OTHER CARRIER RELATED' },
  OLHNS: { lenovoCode: 'A98', description: 'FORWARDER CAPACITY ISSUE' },
  OLHNT: { lenovoCode: 'AV', description: 'EXCEEDS SERVICE LIMITATION' },
  OMNIF: { lenovoCode: 'P01', description: 'PROCESSING DELAY' },
  OMNII: { lenovoCode: 'C6', description: 'WAITING SHIPPING INSTRUCTIONS' },
  PACK: { lenovoCode: 'A13', description: 'OTHER' },
  PUE: { lenovoCode: 'A40', description: 'SHIPPER RELATED' },
  PWD: { lenovoCode: 'SOW', description: 'SHIPMENT OVERWEIGHT' },
  RAD: { lenovoCode: 'BK', description: 'PRE-ARRANGED APPOINTMENT' },
  REALA: { lenovoCode: 'AJ', description: 'OTHER CARRIER RELATED' },
  REALR: { lenovoCode: 'AJ', description: 'OTHER CARRIER RELATED' },
  REFU: { lenovoCode: 'A07', description: 'REFUSED BY CONSIGNEE' },
  SHI: { lenovoCode: 'AM', description: 'SHIPPER RELATED' },
  SHORT: { lenovoCode: 'S01', description: 'INCOMPLETE DELIVERY' },
  SLC: { lenovoCode: 'SLD', description: 'SERVICE LEVEL DECREASE' },
  SOS: { lenovoCode: 'A43', description: 'WEATHER OR NATURAL DISASTER RELATED' },
  SSSF: { lenovoCode: 'A12', description: 'PACKAGE SORTED TO WRONG ROUTE' },
  TFIDI: { lenovoCode: 'A2', description: 'INCORRECT ADDRESS / UNABLE TO LOCATE' },
  TFMIS: { lenovoCode: 'A2', description: 'INCORRECT ADDRESS / UNABLE TO LOCATE' },
  THEFT: { lenovoCode: '019', description: 'CASUALTY LOSS' },
  URC: { lenovoCode: 'A46', description: 'RECIPIENT UNAVAILABLE-DELIVERY DELAYED' },
  WADD: { lenovoCode: 'A03', description: 'INCORRECT ADDRESS' },
};

function getLenovoException(wtCode) {
  const exception = exceptionMapping[wtCode];
  if (exception) {
    return exception;
  }
  return { lenovoCode: 'Unknown', description: 'No matching Lenovo exception code found' };
}
