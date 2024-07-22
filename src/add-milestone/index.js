'use strict';

const AWS = require('aws-sdk');
const { get, includes, isEmpty } = require('lodash');
const moment = require('moment-timezone');
const { dbQuery, putItem } = require('../shared/dynamo');
const { xmlToJson, cstDateTime, STATUSES } = require('../shared/helper');
const {
  getDataFromCustomerList,
  queryCreateShipment,
  getLenovoException,
  handleError,
  validateCWResponse,
  sendToCW,
  payloadToCWforDelays,
  payloadToCW,
  checkExistingRecord,
} = require('./helper');

module.exports.handler = async (event, context) => {
  try {
    console.info('🚀 ~ file: index.js:15 ~ module.exports.handler= ~ event:', event);
    const record = get(event, 'Records[0]', {});
    const recordBody = JSON.parse(get(record, 'body', ''));
    const message = JSON.parse(get(recordBody, 'Message', ''));
    console.info('🚀 ~ file: index.js:26 ~ module.exports.handler= ~ message:', message);
    const dynamoTableName = get(message, 'dynamoTableName', '');
    const newImage = get(message, 'NewImage', {});
    const oldImage = get(message, 'OldImage', undefined);
    const data = AWS.DynamoDB.Converter.unmarshall(newImage);
    const orderNo = get(data, 'FK_OrderNo', '');
    console.info('🚀 ~ file: index.js:32 ~ module.exports.handler= ~ orderNo:', orderNo)

    const headerParams = {
      TableName: process.env.SHIPMENT_HEADER_TABLE,
      KeyConditionExpression: 'PK_OrderNo = :orderNo',
      FilterExpression: 'ShipQuote = :shipquote',
      ExpressionAttributeValues: {
        ':orderNo': orderNo,
        ':shipquote': 'S',
      },
    };

    const shipmentHeaderResult = await dbQuery(headerParams);

    if (shipmentHeaderResult.length === 0) {
      return `No data found in ${process.env.SHIPMENT_HEADER_TABLE} for PK_OrderNo: ${orderNo}.`;
    }

    const billNo = get(shipmentHeaderResult, 'BillNo', '');
    const housebill = get(shipmentHeaderResult, 'Housebill', '');

    const customerListResult = await getDataFromCustomerList(billNo);

    if (customerListResult.length === 0) {
      return `Bill-to ${billNo} is not in the customer list.`;
    }

    const allowedMilestones = get(customerListResult, '[0]AllowedMilestoned', []);
    const milestoneMapping = get(customerListResult, '[0]MilestonesMapping', {});

    const existingRecord = await queryCreateShipment(housebill);

    if (!existingRecord) {
      return `This shipment ${orderNo} is not created from this integration`;
    }

    if (dynamoTableName === `omni-wt-rt-shipment-milestone-${process.env.STAGE}`) {
      await handleShipmentMilestone(data, oldImage, allowedMilestones, milestoneMapping, housebill);
    } else if (dynamoTableName === `omni-wt-rt-apar-failure-${process.env.STAGE}`) {
      await handleAparFailure(data, housebill);
    }
    return STATUSES.SUCCESS;
  } catch (error) {
    console.error('Error in handler:', error);
    await handleError(error, context, event);
    throw error;
  }
};

async function handleShipmentMilestone(
  data,
  oldImage,
  allowedMilestones,
  milestoneMapping,
  housebill
) {
  const orderNo = get(data, 'FK_OrderNo', '');
  const orderStatusId = get(data, 'FK_OrderStatusId', '');
  const eventDateTime = get(data, 'EventDateTime', '');
  const oldEventDateTime = oldImage
    ? get(AWS.DynamoDB.Converter.unmarshall(oldImage), 'EventDateTime')
    : null;

  if (oldEventDateTime === eventDateTime) {
    const isRecordSent = await checkExistingRecord(orderNo, orderStatusId);
    if (isRecordSent) {
      console.info(
        `Record with OrderNo: ${orderNo} and OrderStatusId: ${orderStatusId} already sent.`
      );
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

  const [referencesResult] = await Promise.all([dbQuery(referenceParams)]);

  if (isEmpty(referencesResult)) {
    throw new Error(
      `No data found in ${process.env.REFERENCE_TABLE} table for FK_OrderNo: ${orderNo}.`
    );
  }

  console.info('Housebill:', housebill);

  const referenceNo = get(referencesResult, '[0].ReferenceNo', '');
  console.info('Reference No:', referenceNo);

  const cwPayload = await payloadToCW(
    referenceNo,
    formattedDateTime,
    orderStatusId,
    milestoneMapping
  );
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
      Housebill: housebill,
      ReferenceNo: referenceNo,
      Status: STATUSES.SENT,
      EventDateTime: formattedDateTime,
      Payload: cwPayload,
      Response: xmlCWResponse,
      InsertedTimeStamp: cstDateTime,
    },
  });
}

async function handleAparFailure(data, housebill) {
  const orderNo = get(data, 'FK_OrderNo', '');
  console.info('🚀 ~ file: index.js:151 ~ module.exports.handler= ~ orderNo:', orderNo);
  const fdCode = get(data, 'FDCode', '');
  console.info('🚀 ~ file: index.js:159 ~ module.exports.handler= ~ fdCode:', fdCode);
  const lenovoException = getLenovoException(fdCode);
  console.info(
    '🚀 ~ file: index.js:161 ~ module.exports.handler= ~ lenovoException:',
    lenovoException
  );
  const lenovoCode = get(lenovoException, 'lenovoCode');
  console.info('🚀 ~ file: test.js:3074 ~ lenovoCode:', lenovoCode);
  const description = get(lenovoException, 'description');
  console.info('🚀 ~ file: test.js:3074 ~ lenovoCode:', description);

  if (lenovoCode === 'Unknown' || isEmpty(lenovoCode)) {
    console.info(
      `For fdCode: ${fdCode} the lenovo exception code is missing. Skipping the process`
    );
    return;
  }

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

  const [referencesResult] = await Promise.all([dbQuery(referenceParams)]);

  if (isEmpty(referencesResult)) {
    throw new Error(
      `No data found in ${process.env.REFERENCE_TABLE} table for FK_OrderNo: ${orderNo}.`
    );
  }

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
    throw new Error(
      `No data found in ${process.env.TRACKING_NOTES_TABLE} table for FK_OrderNo: ${orderNo}.`
    );
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
      OrderStatusId: `DELAY-${fdCode}-${description}`,
      Housebill: housebill,
      ReferenceNo: referenceNo,
      Status: STATUSES.SENT,
      EventDateTime: formattedDateTime,
      Payload: cwPayload,
      Response: xmlCWResponse,
      InsertedTimeStamp: cstDateTime,
    },
  });
}
