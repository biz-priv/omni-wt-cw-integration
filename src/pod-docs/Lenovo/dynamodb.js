'use strict';

const AWS = require('aws-sdk');
const { getCstTimestamp, STATUSES, getDynamoUpdateParam } = require('./helper');
const { get } = require('lodash');

const dynamoDB = new AWS.DynamoDB.DocumentClient();

async function getShipemntHeaderData({ orderNo }) {
  const params = {
    TableName: process.env.SHIPMENT_HEADER,
    KeyConditionExpression: 'PK_OrderNo = :orderNo',
    ExpressionAttributeValues: {
      ':orderNo': orderNo,
    },
  };
  return get(await dbRead(params), 'Items', []);
}

async function getReferencesData({ orderNo }) {
  const params = {
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
  return get(await dbRead(params), 'Items', []);
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

async function insertIntoDocStatusTable({
  orderNo,
  status,
  message,
  docType,
  functionName,
  fileExtension,
  tableStatuses,
  billNo,
  houseBill,
  refNumber
}) {
  try {
    const insertParams = {
      TableName: process.env.DOC_STATUS_TABLE,
      Item: {
        OrderNo: orderNo,
        Status: status,
        DocType: docType,
        FileExtension: fileExtension,
        BillNo: billNo,
        HouseBill: houseBill,
        RetryCount: 0,
        Payload: '',
        TableStatuses: tableStatuses,
        Message: message,
        CreatedAt: getCstTimestamp(),
        LastUpdatedAt: getCstTimestamp(),
        LastUpdateBy: functionName,
        ReferenceNo: refNumber
      },
    };
    console.info('🙂 -> file: dynamodb.js:86 -> insertParams:', insertParams);
    return await dynamoDB.put(insertParams).promise();
  } catch (error) {
    throw new Error(
      `Error inserting into doc status table. Order id: ${orderNo}, message: ${error.message}`
    );
  }
}

async function getDocStatusTableData({ orderNo }) {
  const params = {
    TableName: process.env.DOC_STATUS_TABLE,
    KeyConditionExpression: 'OrderNo = :orderNo',
    FilterExpression: '#Status = :status',
    ExpressionAttributeNames: {
      '#Status': 'Status',
    },
    ExpressionAttributeValues: {
      ':orderNo': orderNo,
      ':status': STATUSES.SENT,
    },
  };
  return get(await dbRead(params), 'Items', []);
}

async function getDocStatusTableDataByStatus({ status }) {
  const params = {
    TableName: process.env.DOC_STATUS_TABLE,
    IndexName: process.env.DOC_STATUS_TABLE_STATUS_INDEX,
    KeyConditionExpression: '#Status = :status',
    ExpressionAttributeNames: {
      '#Status': 'Status',
    },
    ExpressionAttributeValues: {
      ':status': status,
    },
  };
  return get(await dbRead(params), 'Items', []);
}

async function deleteDocStatusTableData({ orderNo, docType }) {
  const params = {
    TableName: process.env.DOC_STATUS_TABLE,
    Key: {
      OrderNo: orderNo,
      DocType: docType,
    },
  };
  return await dynamoDB.delete(params).promise();
}

async function updateDocStatusTableData({
  orderNo,
  docType,
  status,
  tableStatuses,
  retryCount,
  functionName,
  message,
  billNo,
  payload,
  response,
  houseBill,
}) {
  const filedsToBeUpdated = {};
  if (status) filedsToBeUpdated.Status = status;
  if (tableStatuses) filedsToBeUpdated.TableStatuses = tableStatuses;
  if (retryCount === 0 || retryCount) filedsToBeUpdated.RetryCount = retryCount + 1;
  if (billNo) filedsToBeUpdated.BillNo = billNo;
  if (message) filedsToBeUpdated.Message = message;
  if (payload) filedsToBeUpdated.Payload = payload;
  if (response) filedsToBeUpdated.Response = response;
  if (houseBill) filedsToBeUpdated.HouseBill = houseBill;
  filedsToBeUpdated.LastUpdatedAt = getCstTimestamp();
  filedsToBeUpdated.LastUpdateBy = functionName;
  console.info(
    '🙂 -> file: dynamodb.js:159 -> updateDocStatusTableData -> filedsToBeUpdated:',
    filedsToBeUpdated
  );
  console.info('🙂 -> file: dynamodb.js:159 -> updateDocStatusTableData -> orderNo:', orderNo);
  console.info('🙂 -> file: dynamodb.js:159 -> updateDocStatusTableData -> docType:', docType);

  const { ExpressionAttributeNames, ExpressionAttributeValues, UpdateExpression } =
    getDynamoUpdateParam(filedsToBeUpdated);
  const params = {
    TableName: process.env.DOC_STATUS_TABLE,
    Key: {
      OrderNo: orderNo,
      DocType: docType,
    },
    UpdateExpression,
    ExpressionAttributeNames,
    ExpressionAttributeValues,
  };
  console.info('🙂 -> file: dynamodb.js:159 -> updateDocStatusTableData -> params:', params);
  return await dynamoDB.update(params).promise();
}

async function dbRead(params) {
  let scanResults = [];
  let items;
  try {
    do {
      console.info('dbRead > params ', params);
      items = await dynamoDB.query(params).promise();
      scanResults = scanResults.concat(get(items, 'Items', []));
      params.ExclusiveStartKey = get(items, 'LastEvaluatedKey');
    } while (typeof items.LastEvaluatedKey !== 'undefined');
  } catch (e) {
    console.error('DynamoDb scan error. ', ' Params: ', params, ' Error: ', e);
    throw e;
  }
  return { Items: scanResults };
}

module.exports = {
  insertIntoDocStatusTable,
  getShipemntHeaderData,
  getDataFromCustomerList,
  getDocStatusTableData,
  getDocStatusTableDataByStatus,
  deleteDocStatusTableData,
  updateDocStatusTableData,
  getReferencesData
};
