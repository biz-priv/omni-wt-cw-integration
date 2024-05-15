'use strict'

const AWS = require('aws-sdk');

const dynamoDB = new AWS.DynamoDB.DocumentClient();
const sns = new AWS.SNS({ apiVersion: '2010-03-31' });
const _ = require('lodash');

async function publishToSNS(message, subject) {
  const params = {
    Message: message,
    Subject: `Lambda function ${subject} has failed.`,
    TopicArn: process.env.ERROR_SNS_ARN,
  };
  try {
    await sns.publish(params).promise();
  } catch (error) {
    console.error(error);
  }
}

async function putItem({ tableName, item }) {
  let params;
  try {
    params = {
      TableName: tableName,
      Item: item,
    };
    return await dynamoDB.put(params).promise();
  } catch (e) {
    console.error('Put Item Error: ', e, '\nPut params: ', params);
    throw new Error('PutItemError');
  }
}

async function dbQuery(params) {
  let scanResults = [];
  let items;
  try {
    do {
      console.info('dbRead > params ', params);
      items = await dynamoDB.query(params).promise();
      scanResults = scanResults.concat(_.get(items, 'Items', []));
      params.ExclusiveStartKey = _.get(items, 'LastEvaluatedKey');
    } while (typeof items.LastEvaluatedKey !== 'undefined');
  } catch (e) {
    console.error('DynamoDb scan error. ', ' Params: ', params, ' Error: ', e);
    throw e;
  }
  return { Items: scanResults };
}

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
  dbQuery, publishToSNS, putItem, getDynamoUpdateParam
}