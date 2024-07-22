'use strict';

const AWS = require('aws-sdk');
const { get, unset, upperCase } = require('lodash');

const { Converter } = AWS.DynamoDB;

const ses = new AWS.SES();
const sqs = new AWS.SQS();
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const { publishToSNS, putItem, dbQuery } = require('../../shared/dynamo');
const { getS3Object, xmlToJson, STATUSES, cstDateTime } = require('../../shared/helper');
const {
  preparePayloadForWT,
  extractData,
  payloadToCW,
  checkHousebillExists,
  payloadToAddTrakingNotesToWT,
} = require('./helper');
const { sendToWT, sendToCW, trackingNotesAPICall } = require('./api');

let s3Bucket = '';
let s3Key = '';

module.exports.handler = async (event, context) => {
  console.info('🙂 -> file: index.js:9 -> event:', JSON.stringify(event));
  let eventType = '';
  let dynamoData = {
    Steps:
      "{'WT Shipment Creation': 'PENDING', 'CW Send Housebill': 'PENDING', 'Add Tracking Notes to WT': 'PENDING'}",
  };
  try {
    if (get(event, 'Records[0].eventSource', '') === 'aws:dynamodb') {
      dynamoData = Converter.unmarshall(get(event, 'Records[0].dynamodb.NewImage'), '');
      s3Bucket = get(dynamoData, 'S3Bucket', '');
      s3Key = get(dynamoData, 'S3Key', '');
      eventType = 'dynamo';
    } else {
      eventType = 'SQS';
      ({ s3Bucket, s3Key } = extractS3Info(event));
      dynamoData = { S3Bucket: s3Bucket, S3Key: s3Key };
      const fileName = s3Key.split('/').pop();
      console.info('🚀 ~ file: index.js:15 ~ module.exports.handler= ~ fileName:', fileName);
      dynamoData.InsertedTimeStamp = cstDateTime;

      const xmlData = await getS3Object(s3Bucket, s3Key);
      dynamoData.XmlFromCW = xmlData;
    }
    const jsonData = await xmlToJson(get(dynamoData, 'XmlFromCW', ''));
    const data = await extractData(jsonData);
    const shipmentId = get(data, 'forwardingShipmentKey', '');
    console.info('🚀 ~ file: index.js:34 ~ module.exports.handler= ~ shipmentId:', shipmentId);
    dynamoData.ShipmentId = shipmentId;

    const payloadToWt = await preparePayloadForWT(data);
    dynamoData.XmlWTPayload = payloadToWt;

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
      dynamoData,
      eventType
    );

    dynamoData.XmlWTResponse = xmlWTResponse;
    dynamoData.XmlCWResponse = xmlCWResponse;

    const xmlPayloadToAddTrakingNotesToWT = await payloadToAddTrakingNotesToWT(
      get(dynamoData, 'Housebill', ''),
      get(dynamoData, 'ShipmentId', '')
    );
    dynamoData.XmlPayloadToAddTrakingNotesToWT = xmlPayloadToAddTrakingNotesToWT;

    const xmlAddTrakingNotesToWTResponse = await trackingNotesAPICall(
      xmlPayloadToAddTrakingNotesToWT
    );
    dynamoData.XmlAddTrakingNotesToWTResponse = xmlAddTrakingNotesToWTResponse;

    const jsonAddTrakingNotesToWTResponse = await xmlToJson(xmlAddTrakingNotesToWTResponse);
    const status = get(
      jsonAddTrakingNotesToWTResponse,
      'soap:Envelope.soap:Body.WriteTrackingNoteResponse.WriteTrackingNoteResult',
      ''
    );
    if (status === 'Success') {
      dynamoData.Steps =
        "{'WT Shipment Creation': 'SENT', 'CW Send Housebill': 'SENT', 'Add Tracking Notes to WT': 'SENT'}";
    } else {
      throw new Error(`Failed to add tracking notes to WT. Received status: ${status}`);
    }

    if (eventType === 'dynamo') {
      publishToSNS({
        message: `Shipment is created successfully after retry.\n\nShipmentId: ${get(dynamoData, 'ShipmentId', '')}.\n\nS3BUCKET: ${s3Bucket}.\n\nS3KEY: ${s3Key}`,
        subject: `${process.env.STAGE} ~ Lenovo - CW to WT Create Shipment Reprocess Success for ShipmentId: ${get(dynamoData, 'ShipmentId', '')}`,
      });
    }

    dynamoData.Status = 'SUCCESS';
    await putItem({ tableName: process.env.LOGS_TABLE, item: dynamoData });
    return 'Success';
  } catch (error) {
    if (eventType === 'SQS') {
      try {
        const receiptHandle = get(event, 'Records[0].receiptHandle', '');

        console.info('receiptHandle:', receiptHandle);

        if (!receiptHandle) {
          throw new Error('No receipt handle found in the event');
        }

        // Delete the message from the SQS queue
        const deleteParams = {
          QueueUrl: process.env.QUEUE_URL,
          ReceiptHandle: receiptHandle,
        };

        await sqs.deleteMessage(deleteParams).promise();
        console.info('Message deleted successfully');
      } catch (e) {
        console.error('Error processing SQS event:', e);
      }
    }
    return await handleError(error, context, event, dynamoData, eventType);
  }
};

function extractS3Info(event) {
  const sqsBody = JSON.parse(get(event, 'Records[0].body', '{}'));

  s3Bucket = get(sqsBody, 's3.bucket.name', '');
  s3Key = get(sqsBody, 's3.object.key', '');

  return { s3Bucket, s3Key };
}

function validateWTResponse(response, payloadToWt) {
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
    throw new Error(`WORLD TRAK API call failed: ${errorMessage}.\n\nPayload: ${payloadToWt}`);
  }
}

function validateCWResponse(response, xmlCWPayload) {
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
      `CARGOWISE API call failed: ${get(response, 'UniversalResponse.ProcessingLog', '')}. \n\nPayload: ${xmlCWPayload}`
    );
  }
}

async function handleError(error, context, event, dynamoData, eventType) {
  console.error('Error:', error);
  try {
    await sendSNSNotification(context, error, dynamoData);
    console.info('SNS notification has been sent');
  } catch (snsError) {
    console.error('Error while sending SNS notification:', snsError);
  }

  const errorMessage = `${error.message}`;
  dynamoData.ErrorMsg = errorMessage;
  dynamoData.Status = STATUSES.FAILED;
  if (eventType === 'dynamo') {
    dynamoData.RetryCount = String(Number(dynamoData.RetryCount) + 1);
  } else {
    dynamoData.RetryCount = '0';
  }
  await putItem({ tableName: process.env.LOGS_TABLE, item: dynamoData });
  return 'Failed';
}

const sendSNSNotification = (context, error, dynamoData) =>
  publishToSNS({
    message: `An error occurred in function ${context.functionName}.\n\n ${error}.\n\nShipmentId: ${get(dynamoData, 'ShipmentId', '')}.\n\nS3BUCKET: ${s3Bucket}.\n\nS3KEY: ${s3Key}.\n\nLAMBDA TRIGGER: This lambda will trigger when there is a XML file dropped in a s3 Bucket(for s3 bucket and the file path, please refer to the event).\n\nRETRIGGER PROCESS: After fixing the issue, please retrigger the process by reuploading the file mentioned in the event.\n\nNote: Use the ShipmentId: ${get(dynamoData, 'ShipmentId', '')} for better search in the logs and also check in dynamodb: ${process.env.LOGS_TABLE} for understanding the complete data.`,
    subject: `LENOVO CREATE SHIPMENT ERROR ~ ShipmentId: ${get(dynamoData, 'ShipmentId', '')}`,
  });

async function checkExistingRecord(shipmentId) {
  const statusParams = {
    TableName: process.env.LOGS_TABLE,
    KeyConditionExpression: 'ShipmentId = :shipmentid',
    ExpressionAttributeValues: {
      ':shipmentid': shipmentId,
    },
  };

  const recordExisting = await dbQuery(statusParams);
  return recordExisting.length > 0 && recordExisting[0].Status === STATUSES.SUCCESS;
}

async function handleExistingRecord(data) {
  console.info(
    `Record with ShipmentId: ${data.ShipmentId} is already sent to WT. Skipping the Process...`
  );

  const shipmentId = get(data, 'ShipmentId', '');
  unset(data, 'ShipmentId');
  const errorMsg = `Record with ShipmentId: ${shipmentId} is already sent to WT.`;
  await sendSESEmail({
    message: `Record with ShipmentId: ${shipmentId} is already sent to WT.\n\nS3 KEY: ${s3Key}.`,
    subject: `${upperCase(process.env.STAGE)} - LENOVO CREATE SHIPMENT DUPLICATES ALERT ~ ShipmentId: ${shipmentId}`,
  });
  await updateDynamoDBRecord(shipmentId, errorMsg, STATUSES.SUCCESS);
  return 'Skipped';
}

async function updateDynamoDBRecord(shipmentId, errorMessage, status) {
  const params = {
    TableName: process.env.LOGS_TABLE,
    Key: { ShipmentId: shipmentId },
    UpdateExpression: `
        SET 
          #InsertedTimeStamp = :InsertedTimeStamp, 
          #ErrorMsg = :ErrorMsg,
          #ResetCount = :resetcount,
          #Status = :status
      `,
    ExpressionAttributeNames: {
      '#InsertedTimeStamp': 'InsertedTimeStamp',
      '#ResetCount': 'ResetCount',
      '#ErrorMsg': 'ErrorMsg',
      '#Status': 'Status',
    },
    ExpressionAttributeValues: {
      ':InsertedTimeStamp': cstDateTime,
      ':ErrorMsg': errorMessage || '',
      ':resetcount': status === STATUSES.SUCCESS ? +1 : 0,
      ':status': status,
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
}

async function processWTAndCW(payloadToWt, shipmentId, dynamoData, eventType) {
  if (eventType === 'dynamo') {
    const checkHousebill = await checkHousebillExists(shipmentId);
    if (checkHousebill !== '') {
      console.info(
        `Housebill already created : The housebill number for '${shipmentId}' already created in WT and the Housebill No. is '${checkHousebill}'`
      );
      const xmlCWPayload = await payloadToCW(shipmentId, checkHousebill);
      const xmlCWResponse = await sendToCW(xmlCWPayload);
      const xmlCWObjResponse = await xmlToJson(xmlCWResponse);
      validateCWResponse(xmlCWObjResponse, xmlCWPayload);
      dynamoData.Steps =
        "{'WT Shipment Creation': 'SENT', 'CW Send Housebill': 'SENT', 'Add Tracking Notes to WT': 'PENDING'}";
      return [get(dynamoData, 'XmlWTResponse', ''), xmlCWResponse];
    }
  }
  const xmlWTResponse = await sendToWT(payloadToWt);
  const xmlWTObjResponse = await xmlToJson(xmlWTResponse);
  validateWTResponse(xmlWTObjResponse, payloadToWt);
  dynamoData.Steps =
    "{'WT Shipment Creation': 'SENT', 'CW Send Housebill': 'PENDING', 'Add Tracking Notes to WT': 'PENDING'}";

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
  validateCWResponse(xmlCWObjResponse, xmlCWPayload);
  dynamoData.Steps =
    "{'WT Shipment Creation': 'SENT', 'CW Send Housebill': 'SENT', 'Add Tracking Notes to WT': 'PENDING'}";

  return [xmlWTResponse, xmlCWResponse];
}

async function sendSESEmail({ message, subject }) {
  try {
    // Split the EMAIL_LIST string into an array of emails
    const emailArray = process.env.DUPLICATES_DL.split(',');
    const params = {
      Destination: {
        ToAddresses: emailArray,
      },
      Message: {
        Body: {
          Text: {
            Data: `${message}`,
            Charset: 'UTF-8',
          },
        },
        Subject: {
          Data: subject,
          Charset: 'UTF-8',
        },
      },
      Source: 'no-reply@omnilogistics.com',
    };
    console.info('🚀 ~ file: helper.js:1747 ~ sendSESEmail ~ params:', params);

    await ses.sendEmail(params).promise();
  } catch (error) {
    console.error('Error sending email with SES:', error);
    throw error;
  }
}
