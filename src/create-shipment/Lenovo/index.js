'use strict';

const AWS = require('aws-sdk');
const { get, unset, upperCase } = require('lodash');

const ses = new AWS.SES();
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const { publishToSNS, putItem, dbQuery } = require('../../shared/dynamo');
const { getS3Object, xmlToJson, STATUSES, cstDateTime } = require('../../shared/helper');
const { preparePayloadForWT, extractData, payloadToCW } = require('./helper');
const { sendToWT, sendToCW } = require('./api');

module.exports.handler = async (event, context) => {
  console.info('🙂 -> file: index.js:9 -> event:', JSON.stringify(event));

  const processRecord = async (record) => {
    const messageBody = JSON.parse(record.body);
    console.info('🚀 ~ Message body:', messageBody);

    const dynamoData = {};

    try {
      const { s3Bucket, s3Key } = messageBody;
      const fileName = s3Key.split('/').pop();
      console.info('🚀 ~ file: index.js:15 ~ module.exports.handler= ~ fileName:', fileName);
      dynamoData.InsertedTimeStamp = cstDateTime;
      dynamoData.S3Bucket = s3Bucket;
      dynamoData.S3Key = s3Key;

      const xmlData = await getS3Object(s3Bucket, s3Key);
      dynamoData.XmlFromCW = xmlData;
      const jsonData = await xmlToJson(xmlData);
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
        await handleExistingRecord(dynamoData);
        return; // Skip further processing for this message
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
    } catch (error) {
      await handleError(error, context, messageBody, dynamoData);
    }
  };

  await Promise.all(event.Records.map(processRecord));

  return 'Success';
};

const validateWTResponse = (response, payloadToWt) => {
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
};

const validateCWResponse = (response, xmlCWPayload) => {
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
};

const handleError = async (error, context, event, dynamoData) => {
  console.error('Error:', error);
  try {
    await sendSNSNotification(context, error, event, dynamoData);
    console.info('SNS notification has been sent');
  } catch (snsError) {
    console.error('Error while sending SNS notification:', snsError);
  }

  const errorMessage = `${error.message}`;
  const shipmentId = get(dynamoData, 'ShipmentId', '');
  unset(dynamoData, 'ShipmentId');
  await updateDynamoDBRecord(shipmentId, errorMessage, STATUSES.FAILED);
  return 'Failed';
};

const sendSNSNotification = (context, error, event, dynamoData) =>
  publishToSNS({
    message: `An error occurred in function ${context.functionName}.\n\n ${error}.\n\nShipmentId: ${get(dynamoData, 'ShipmentId', '')}.\n\nEVENT: ${JSON.stringify(event)}.\n\nS3BUCKET: ${get(dynamoData, 'S3Bucket', '')}.\n\nS3KEY: ${get(dynamoData, 'S3Key', '')}.\n\nLAMBDA TRIGGER: This lambda will trigger when there is a XML file dropped in a s3 Bucket(for s3 bucket and the file path, please refer to the event).\n\nRETRIGGER PROCESS: After fixing the issue, please retrigger the process by reuploading the file mentioned in the event.\n\nNote: Use the ShipmentId: ${get(dynamoData, 'ShipmentId', '')} for better search in the logs and also check in dynamodb: ${process.env.LOGS_TABLE} for understanding the complete data.`,
    subject: `${upperCase(process.env.STAGE)} - LENOVO CREATE SHIPMENT ERROR ~ ShipmentId: ${get(dynamoData, 'ShipmentId', '')}`,
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
  const errorMsg = `Record with ShipmentId: ${shipmentId} is already sent to WT.`;
  await sendSESEmail({
    message: `Record with ShipmentId: ${shipmentId} is already sent to WT.\n\nS3 KEY: ${data.S3Key}.`,
    subject: `${upperCase(process.env.STAGE)} - LENOVO CREATE SHIPMENT DUPLICATES ALERT ~ ShipmentId: ${shipmentId}`,
  });
  await updateDynamoDBRecord(shipmentId, errorMsg, STATUSES.SUCCESS);
  return 'Skipped';
};

const updateDynamoDBRecord = async (shipmentId, errorMessage, status) => {
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
};

const processWTAndCW = async (payloadToWt, shipmentId, dynamoData) => {
  const xmlWTResponse = await sendToWT(payloadToWt);
  const xmlWTObjResponse = await xmlToJson(xmlWTResponse);
  validateWTResponse(xmlWTObjResponse, payloadToWt);

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

  return [xmlWTResponse, xmlCWResponse];
};

async function sendSESEmail({ message, subject }) {
  try {
    const params = {
      Destination: {
        ToAddresses: ['kvallabhaneni@omnilogistics.com', 'omnidev@bizcloudexperts.com', 'alwhite@omnilogistics.com'],
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
