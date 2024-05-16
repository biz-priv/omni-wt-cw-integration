'use strict';

const { get } = require('lodash');

const { publishToSNS } = require('../shared/dynamo');
const { getS3Object } = require('../shared/helper');
const { prepareWTpayload } = require('./api');

module.exports.handler = async (event, context) => {
  console.info('🙂 -> file: index.js:9 -> event:', JSON.stringify(event));

  try {
    // Extract XML file from S3 event
    const s3Bucket = get(event, 'Records[0].s3.bucket.name', '');
    const s3Key = get(event, 'Records[0].s3.object.key', '');
    const fileName = s3Key.split('/').pop();
    console.info('🚀 ~ file: index.js:15 ~ module.exports.handler= ~ fileName:', fileName);
    // Get XML data from S3
    const xmlData = await getS3Object(s3Bucket, s3Key);
    console.info('🚀 ~ file: index.js:18 ~ module.exports.handler= ~ xmlData:', xmlData);
    // const jsonData = await xmlToJson(xmlData);
    // console.info('🚀 ~ file: index.js:16 ~ module.exports.handler= ~ jsonData:', jsonData);
    const payloadToWt = await prepareWTpayload(xmlData);
    console.info('🚀 ~ file: index.js:28 ~ module.exports.handler= ~ payloadToWt:', payloadToWt);
  } catch (error) {
    console.error('Error:', error);
    // Send SNS notification
    await publishToSNS(`Error occurred in Lambda function ${context.functionName}`, error.message);
    throw error;
  }
};
