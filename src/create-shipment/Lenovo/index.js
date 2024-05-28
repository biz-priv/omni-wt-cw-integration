'use strict';

const AWS = require('aws-sdk');
const { get, unset } = require('lodash');

const dynamoDB = new AWS.DynamoDB.DocumentClient();
const { publishToSNS, putItem, dbQuery } = require('../../shared/dynamo');
const { getS3Object, xmlToJson, STATUSES, cstDateTime } = require('../../shared/helper');
const { preparePayloadForWT, extractData, payloadToCW } = require('./helper');
const { sendToWT, sendToCW } = require('./api');

let s3Bucket = '';
let s3Key = '';

module.exports.handler = async (event, context) => {
  console.info('🙂 -> file: index.js:9 -> event:', JSON.stringify(event));
  const dynamoData = {};

  try {
    ({ s3Bucket, s3Key } = extractS3Info(event));
    const fileName = s3Key.split('/').pop();
    console.info('🚀 ~ file: index.js:15 ~ module.exports.handler= ~ fileName:', fileName);
    dynamoData.InsertedTimeStamp = cstDateTime;

    const xmlData = await getS3Object(s3Bucket, s3Key);
    dynamoData.XmlFromCW = xmlData;

    const jsonData = await xmlToJson(xmlData);
    const data = await extractData(jsonData);

    const payloadToWt = await preparePayloadForWT(data);
    dynamoData.XmlWTPayload = payloadToWt;
    const shipmentId = get(data, 'forwardingShipmentKey', '');
    console.info('🚀 ~ file: index.js:34 ~ module.exports.handler= ~ shipmentId:', shipmentId);
    dynamoData.ShipmentId = shipmentId;

    const recordExisting = await checkExistingRecord(shipmentId);
    console.info(
      '🚀 ~ file: index.js:36 ~ module.exports.handler= ~ recordExisting:',
      recordExisting
    );

    if (recordExisting) {
      return await handleExistingRecord(dynamoData);
    }

    const [xmlWTResponse, xmlCWResponse] = await processWTAndCW(
      payloadToWt,
      shipmentId,
      dynamoData
    );

    dynamoData.XmlWTResponse = xmlWTResponse;
    dynamoData.XmlCWResponse = xmlCWResponse;

    dynamoData.Status = 'SUCCESS';
    await putItem({ tableName: process.env.LOGS_TABLE, item: dynamoData });
    return 'Success';
  } catch (error) {
    return await handleError(error, context, event, dynamoData);
  }
};

const extractS3Info = (event) => ({
  s3Bucket: get(event, 'Records[0].s3.bucket.name', ''),
  s3Key: get(event, 'Records[0].s3.object.key', ''),
});

const validateWTResponse = (response) => {
  const errorMessage = get(
    response,
    'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.ErrorMessage',
    ''
  );
  const housebill = get(
    response,
    'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.Housebill',
    ''
  );

  if (errorMessage || !housebill) {
    throw new Error(`WORLD TRAK API call failed: ${errorMessage}`);
  }
};

const validateCWResponse = (response) => {
  const eventType = get(response, 'UniversalResponse.Data.UniversalEvent.Event.EventType', '');
  const context = get(
    response,
    'UniversalResponse.Data.UniversalEvent.Event.ContextCollection.Context',
    []
  );
  const processingStatusCode =
    context.find((obj) => obj.Type === 'ProcessingStatusCode')?.Value || '';

  if (eventType !== 'DIM' || processingStatusCode !== 'PRS') {
    throw new Error(
      `CARGOWISE API call failed: ${get(response, 'UniversalResponse.ProcessingLog', '')}`
    );
  }
};

const handleError = async (error, context, event, dynamoData) => {
  console.error('Error:', error);
  try {
    await sendSNSNotification(context, error, event, dynamoData);
    console.info('SNS notification has been sent');
  } catch (snsError) {
    console.error('Error while sending SNS notification:', snsError);
  }

  dynamoData.ErrorMsg = `${error}`;
  dynamoData.Status = STATUSES.FAILED;
  await putItem({ tableName: process.env.LOGS_TABLE, item: dynamoData });
  return 'Failed';
};

const sendSNSNotification = (context, error, event, dynamoData) =>
  publishToSNS({
    message: `An error occurred in function ${context.functionName}.\n\nERROR DETAILS: ${error.message}.\n\nShipmentId: ${get(dynamoData, 'ShipmentId', '')}.\n\n Xml From CW: ${get(dynamoDB, 'XmlFromCW', '')}.\n\nXml to WT: ${get(dynamoDB, 'XmlWTPayload', '')}. \n\nEVENT: ${JSON.stringify(event)}.\n\nS3BUCKET: ${s3Bucket}.\n\nS3KEY: ${s3Key}.\n\nLAMBDA TRIGGER: This lambda will trigger when there is a XML file dropped in a s3 Bucket(for s3 bucket and the file path, please refer to the event).\n\nRETRIGGER PROCESS: After fixing the issue, please retrigger the process by reuploading the file mentioned in the event.\n\nNote: Use the ShipmentId: ${get(dynamoData, 'ShipmentId', '')} for better search in the logs and also check in dynamodb: ${process.env.LOGS_TABLE} for understanding the complete data.`,
    subject: `LENOVO CREATE SHIPMENT ERROR ~ ShipmentId: ${get(dynamoData, 'ShipmentId', '')}`,
  });

const checkExistingRecord = async (shipmentId) => {
  const statusParams = {
    TableName: process.env.LOGS_TABLE,
    KeyConditionExpression: 'ShipmentId = :shipmentid',
    ExpressionAttributeValues: {
      ':shipmentid': shipmentId,
    },
  };

  const recordExisting = await dbQuery(statusParams);
  return recordExisting.length > 0 && recordExisting[0].Status === STATUSES.SUCCESS;
};

const handleExistingRecord = async (data) => {
  console.info(
    `Record with ShipmentId: ${data.ShipmentId} is already sent to WT. Skipping the Process...`
  );

  const shipmentId = get(data, 'ShipmentId', '');
  unset(data, 'ShipmentId');

  data.ResetCount = Number(get(data, 'ResetCount', 0)) + 1;
  data.ErrorMsg = `Record with ShipmentId: ${shipmentId} is already sent to WT. Skipping the Process...`;

  await updateDynamoDBRecord(shipmentId, data);
  return 'Skipped';
};

const updateDynamoDBRecord = async (shipmentId, data) => {
  const params = {
    TableName: process.env.LOGS_TABLE,
    Key: { ShipmentId: shipmentId },
    UpdateExpression: `
        SET 
          #InsertedTimeStamp = :InsertedTimeStamp, 
          #ErrorMsg = :ErrorMsg,
          #ResetCount = if_not_exists(#ResetCount, :start) + :increment
      `,
    ConditionExpression: 'attribute_not_exists(ShipmentId) OR #Status <> :success',
    ExpressionAttributeNames: {
      '#InsertedTimeStamp': 'InsertedTimeStamp',
      '#ResetCount': 'ResetCount',
      '#ErrorMsg': 'ErrorMsg',
      '#Status': 'Status',
    },
    ExpressionAttributeValues: {
      ':InsertedTimeStamp': get(data, 'InsertedTimeStamp', ''),
      ':ErrorMsg': get(data, 'ErrorMsg', ''),
      ':start': 0,
      ':increment': 1,
      ':success': STATUSES.SUCCESS,
    },
    ReturnValues: 'UPDATED_NEW',
  };

  try {
    const result = await dynamoDB.update(params).promise();
    console.info('Successfully updated record:', result);
    return result;
  } catch (error) {
    console.error('Error updating record:', error);
    throw new Error('UpdateItemError');
  }
};

const processWTAndCW = async (payloadToWt, shipmentId, dynamoData) => {
  const xmlWTResponse = await sendToWT(payloadToWt);
  const xmlWTObjResponse = await xmlToJson(xmlWTResponse);
  validateWTResponse(xmlWTObjResponse);

  const housebill = get(
    xmlWTObjResponse,
    'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.Housebill',
    ''
  );
  console.info('🚀 ~ file: index.js:54 ~ module.exports.handler= ~ housebill:', housebill);
  dynamoData.Housebill = housebill;

  const xmlCWPayload = await payloadToCW(shipmentId, housebill);
  const xmlCWResponse = await sendToCW(xmlCWPayload);
  const xmlCWObjResponse = await xmlToJson(xmlCWResponse);
  validateCWResponse(xmlCWObjResponse);

  return [xmlWTResponse, xmlCWResponse];
};
