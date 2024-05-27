'use strict';
const AWS = require('aws-sdk');
const moment = require('moment-timezone');

const { REGION } = process.env;

const STATUSES = {
  PENDING: 'PENDING',
  READY: 'READY',
  FAILED: 'FAILED',
  SENT: 'SENT',
  SKIPPED: 'SKIPPED',
};

const tableStatuses = {
  SHIPMENT_HEADER_TABLE: STATUSES.PENDING,
};

async function publishToSNS(message, functionName) {
  const sns = new AWS.SNS({ region: REGION });

  const params = {
    Message: `${message} \n Retrigger process: Set the status to PENDING and ResetCount to 0 of that particular record in ${process.env.DOC_STATUS_TABLE} after fixing the issue.`,
    Subject: `Lambda function ${functionName} has failed.`,
    TopicArn: process.env.ERROR_SNS_TOPIC_ARN,
  };
  console.info('🙂 -> file: helper.js:28 -> publishToSNS -> params:', params);
  try {
    await sns.publish(params).promise();
  } catch (error) {
    console.error(error);
  }
}

function getCstTimestamp(date = new Date()) {
  return moment(date).tz('America/Chicago').format('YYYY:MM:DD HH:mm:ss');
}

const tableParams = {
  SHIPMENT_HEADER_TABLE: ({ orderNo }) => ({
    TableName: process.env.SHIPMENT_HEADER_TABLE,
    KeyConditionExpression: 'PK_OrderNo = :orderNo',
    ExpressionAttributeValues: {
      ':orderNo': orderNo,
    },
  }),
};

function getDynamoUpdateParam(data) {
  const ExpressionAttributeNames = {};
  const ExpressionAttributeValues = {};
  let UpdateExpression = [];
  if (typeof data !== 'object' || !data || Array.isArray(data) || Object.keys(data).length === 0) {
    return { ExpressionAttributeNames, ExpressionAttributeValues, UpdateExpression };
  }

  Object.keys(data).forEach((key) => {
    ExpressionAttributeValues[`:${key}`] = data[key];
    ExpressionAttributeNames[`#${key}`] = key;
    UpdateExpression.push(`#${key} = :${key}`);
  });

  UpdateExpression = UpdateExpression.join(', ');
  UpdateExpression = `set ${UpdateExpression}`;

  return { ExpressionAttributeNames, ExpressionAttributeValues, UpdateExpression };
}


module.exports = {
  STATUSES,
  tableStatuses,
  publishToSNS,
  getCstTimestamp,
  tableParams,
  getDynamoUpdateParam,
};
