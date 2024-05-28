'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');
const xml2js = require('xml2js');
const axios = require('axios');
const { STATUSES, publishToSNS, getCstTimestamp } = require('./helper');
const { getDataFromCustomerList, updateDocStatusTableData } = require('./dynamodb');

let functionName;

module.exports.handler = async (event, context) => {
  functionName = get(context, 'functionName');

  console.info('Event received:', JSON.stringify(event));

  const processRecord = async (record) => {
    console.info('Processing record:', record);
    const newImage = get(record, 'dynamodb.NewImage');
    const unmarshalledImage = AWS.DynamoDB.Converter.unmarshall(newImage);

    const fileExtension = get(unmarshalledImage, 'FileExtension');
    const billNo = get(unmarshalledImage, 'BillNo');
    const houseBill = get(unmarshalledImage, 'HouseBill');
    const fileNumber = get(unmarshalledImage, 'OrderNo');
    const docType = get(unmarshalledImage, 'DocType');
    const referenceNo = get(unmarshalledImage, 'ReferenceNo');

    console.info('File Number:', fileNumber);
    console.info('Doc Type:', docType);
    console.info('File Extension:', fileExtension);

    try {
      const [customerData] = await getDataFromCustomerList({ billNo });
      const webSliKey = get(customerData, 'WebSliKey');

      console.info('WebSliKey:', webSliKey);

      const { b64str, filename } = await getDocFromWebsli({
        apiKey: webSliKey,
        docType,
        houseBill,
      });

      const payload = payloadToCW(b64str, filename, referenceNo);
      console.info('Payload to CW:', payload);

      const xmlCWResponse = await sendToCW(payload);
      console.info('CW Response:', xmlCWResponse);

      const xmlCWObjResponse = await xmlToJson(xmlCWResponse);
      validateCWResponse(xmlCWObjResponse);

      const sazitizedPayload = stringReplacer({
        mainString: payload,
        startString: '<ImageData>',
        endString: '</ImageData>',
        replacer: 'base64_content',
      });

      console.info('sazitizedPayload:', sazitizedPayload);

      return await updateDocStatusTableData({
        docType,
        orderNo: fileNumber,
        functionName,
        payload: sazitizedPayload,
        response: xmlCWResponse,
        status: STATUSES.SENT,
        message: 'Document sent successfully.',
      });
    } catch (error) {
      console.error('Error processing record:', error);
      await updateDocStatusTableData({
        docType,
        functionName,
        message: error.message,
        orderNo: fileNumber,
        status: STATUSES.FAILED,
      });
      await publishToSNS(
        `OrderId: ${fileNumber}, DocType: ${docType}\n${error.message}\n`,
        functionName
      );
      return false;
    }
  };

  await Promise.all(event.Records.map(processRecord));
};

async function getDocFromWebsli({ houseBill, apiKey, docType }) {
  const url = `${process.env.GET_DOCUMENT_API}/${apiKey}/housebill=${houseBill}/doctype=${docType}`;
  console.info('Websli URL:', url);

  try {
    const response = await axios.get(url);
    const { filename, b64str } = get(response, 'data.wtDocs.wtDoc[0]', {});
    return { filename, b64str };
  } catch (error) {
    const message = get(error, 'response.data', '');
    console.error('Error calling websli endpoint:', message || error.message);
    throw error;
  }
}

async function sendToCW(postData) {
  const config = {
    url: process.env.CW_URL,
    method: 'post',
    headers: {
      Authorization: process.env.CW_ENDPOINT_AUTHORIZATION,
    },
    data: postData,
  };

  console.info('Sending data to CW with config:', config);

  try {
    const response = await axios.request(config);
    if (get(response, 'status') === 200) {
      return get(response, 'data');
    }
    throw new Error(`CARGOWISE API Request Failed: ${response}`);
  } catch (error) {
    console.error('CARGOWISE API Request Failed:', error);
    throw error;
  }
}

function payloadToCW(b64str, filename, referenceNo) {
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
              Type: 'WarehouseOrder',
              Key: referenceNo,
            },
          },
        },
        EventTime: getCstTimestamp(),
        EventType: 'DDI',
        EventReference: 'POD',
        IsEstimate: 'false',
        AttachedDocumentCollection: {
          AttachedDocument: {
            FileName: filename,
            ImageData: b64str,
            Type: {
              Code: 'POD',
            },
            IsPublished: 'true',
          },
        },
      },
    },
  };

  try {
    return builder.buildObject(xmlData);
  } catch (error) {
    console.error('Error in building XML payload:', error);
    throw error;
  }
}

async function xmlToJson(xmlData) {
  const parser = new xml2js.Parser({
    explicitArray: false,
    mergeAttrs: true,
  });

  try {
    return await parser.parseStringPromise(xmlData);
  } catch (error) {
    console.error('Error in converting XML to JSON:', error);
    throw error;
  }
}

function validateCWResponse(response) {
  const eventType = get(response, 'UniversalResponse.Data.UniversalEvent.Event.EventType');
  const contextCollection = get(
    response,
    'UniversalResponse.Data.UniversalEvent.Event.ContextCollection.Context',
    []
  );
  const contentType =
    contextCollection.find((ctx) => get(ctx, 'Type') === 'ProcessingStatusCode')?.Value || '';

  if (eventType !== 'DIM' || contentType !== 'PRS') {
    const processingLog = get(response, 'UniversalResponse.ProcessingLog', '');
    throw new Error(`CARGOWISE API call failed: ${processingLog}`);
  }
}

function stringReplacer({ mainString, startString, endString, replacer }) {
  const startIndex = mainString.search(startString) + startString.length;
  console.info(
    ':slightly_smiling_face: -> file: sender.js:272 -> stringReplacer -> startIndex:',
    startIndex
  );
  const endIndex = mainString.search(endString);
  console.info(
    ':slightly_smiling_face: -> file: sender.js:274 -> stringReplacer -> endIndex:',
    endIndex
  );
  if (endIndex === -1) return mainString;
  return mainString.replace(mainString.substring(startIndex, endIndex), replacer);
}
