'use strict';

const AWS = require('aws-sdk');
const momentTZ = require('moment-timezone');
const xml2js = require('xml2js');

const s3 = new AWS.S3();

const cstDateTime = momentTZ.tz('America/Chicago').format('YYYY/MM/DD HH:mm:ss').toString();

const STATUSES = {
  PENDING: 'PENDING',
  READY: 'READY',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SUCCESS: 'SUCCESS',
  SKIPPED: 'SKIPPED',
};

async function getS3Object(bucket, key) {
  try {
    const params = { Bucket: bucket, Key: key };
    const response = await s3.getObject(params).promise();
    return response.Body.toString();
  } catch (error) {
    throw new Error(`S3 error: ${error}`);
  }
}

async function xmlToJson(xmlData) {
  try {
    const parser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true,
    });
    return await parser.parseStringPromise(xmlData);
  } catch (error) {
    console.error('Error in xmlToJson: ', error);
    throw error;
  }
}

module.exports = {
  cstDateTime,
  STATUSES,
  getS3Object,
  xmlToJson,
};
