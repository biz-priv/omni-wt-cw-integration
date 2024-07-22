'use strict';

const AWS = require('aws-sdk');
const { get } = require('lodash');
const axios = require('axios');
const xml2js = require('xml2js');
const { dbQuery, publishToSNS, getDynamoUpdateParam, dbRead } = require('../shared/dynamo');
const { cstDateTime, STATUSES } = require('../shared/helper');

const dynamoDB = new AWS.DynamoDB.DocumentClient();

async function checkExistingRecord(orderNo, orderStatusId) {
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
}

async function payloadToCW(referenceNo, eventDateTime, orderStatusId, milestoneMapping) {
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
          EventType: get(milestoneMapping, orderStatusId),
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

function validateCWResponse(response) {
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
}

async function handleError(error, context, event) {
  console.error('Error:', error);
  const record = get(event, 'Records[0]', {});
  const recordBody = JSON.parse(get(record, 'body', ''));
  const message = JSON.parse(get(recordBody, 'Message', ''));
  const data = AWS.DynamoDB.Converter.unmarshall(get(message, 'NewImage', {}));
  const orderNo = get(data, 'FK_OrderNo', '');
  let orderStatusId;
  let fdCode;
  let lenovoException;
  let description;
  if (
    get(message, 'dynamoTableName', '') === `omni-wt-rt-shipment-milestone-${process.env.STAGE}`
  ) {
    orderStatusId = get(data, 'FK_OrderStatusId', '');
  } else {
    fdCode = get(data, 'FDCode', '');
    console.info('🚀 ~ file: index.js:159 ~ module.exports.handler= ~ fdCode:', fdCode);
    lenovoException = getLenovoException(fdCode);
    console.info(
      '🚀 ~ file: index.js:161 ~ module.exports.handler= ~ lenovoException:',
      lenovoException
    );
    description = get(lenovoException, 'description');
    console.info('🚀 ~ file: test.js:3074 ~ lenovoCode:', description);
    orderStatusId = `DELAY-${fdCode}-${description}`;
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
}

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

async function getDataFromCustomerList({ billNo }) {
  const params = {
    TableName: process.env.CUSTOMER_LIST_TABLE,
    KeyConditionExpression: 'BillNo = :billNo',
    ExpressionAttributeValues: {
      ':billNo': billNo,
    },
  };
  return get(await dbRead(params), 'Items', []);
}

async function queryCreateShipment(housebill) {
  const statusParams = {
    TableName: process.env.LOGS_TABLE,
    IndexName: 'Housebill-index',
    KeyConditionExpression: 'Housebill = :housebill',
    ExpressionAttributeValues: {
      ':housebill': housebill,
    },
  };

  const recordExisting = await dbQuery(statusParams);
  return recordExisting.length > 0 && recordExisting[0].Status === STATUSES.SUCCESS;
}

module.exports = {
  getDataFromCustomerList,
  queryCreateShipment,
  getLenovoException,
  handleError,
  validateCWResponse,
  sendToCW,
  payloadToCWforDelays,
  payloadToCW,
  checkExistingRecord,
};
