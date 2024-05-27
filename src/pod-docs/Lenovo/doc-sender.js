'use strict';

const { get, set } = require('lodash');
const AWS = require('aws-sdk');
const xml2js = require('xml2js');
const { STATUSES, publishToSNS, getCstTimestamp } = require('./helper');
const { default: axios } = require('axios');
const { getDataFromCustomerList, updateDocStatusTableData } = require('./dynamodb');

let functionName;
module.exports.handler = async (event, context) => {
  functionName = get(context, 'functionName');

  console.info(
    '🙂 -> file: doc-sender.js:4 -> module.exports.handler= -> event:',
    JSON.stringify(event)
  );
  await Promise.all(
    event.Records.map(async (record) => {
      console.info('🙂 -> file: doc-sender.js:13 -> event.Records.map -> record:', record);
      const {
        dynamodb: { NewImage },
      } = record;
      const {
        FileExtension: fileExtension,
        BillNo: billNo,
        HouseBill: houseBill,
        ...rest
      } = AWS.DynamoDB.Converter.unmarshall(NewImage);
      const fileNumber = get(rest, 'OrderNo');
      const docType = get(rest, 'DocType');
      console.info('🙂 -> file: doc-sender.js:21 -> event.Records.map -> fileNumber:', fileNumber);
      console.info('🙂 -> file: doc-sender.js:18 -> event.Records.map -> docType:', docType);
      console.info(
        '🙂 -> file: doc-sender.js:18 -> event.Records.map -> fileExtension:',
        fileExtension
      );
      try {
        const [{ WebSliKey: webSliKey }] = await getDataFromCustomerList({
          billNo,
        });
        console.info('🙂 -> file: doc-sender.js:27 -> event.Records.map -> webSliKey:', webSliKey);
        const { b64str, filename } = await getDocFromWebsli({
          apiKey: webSliKey,
          docType,
          houseBill,
        });
        // const payload = {
        //   load: {
        //     identifier: 'proNumber',
        //     value: houseBill,
        //   },
        //   documents: [
        //     {
        //       type: fileExtension,
        //       document_type: docTypeMapping[docType.toUpperCase()],
        //       base64_content: b64str,
        //     },
        //   ],
        // };
        const payload = payloadToCW(b64str, filename);

        const response = await sendToCW(payload);
        console.info('🙂 -> file: doc-sender.js:23 -> event.Records.map -> payload:', payload);
        set(payload, 'documents[0].base64_content', 'base64_content');
        return await updateDocStatusTableData({
          docType,
          orderNo: fileNumber,
          functionName,
          payload,
          response,
          status: STATUSES.SENT,
          message: 'Document sent successfully.',
        });
      } catch (error) {
        console.info('🙂 -> file: doc-sender.js:36 -> event.Records.map -> error:', error);
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
    })
  );
};

async function getDocFromWebsli({ houseBill, apiKey, docType }) {
  try {
    const url = `${process.env.GET_DOCUMENT_API}/${apiKey}/housebill=${houseBill}/doctype=${docType}`;
    const queryType = await axios.get(url);
    console.info('🙂 -> file: pod-doc-sender.js:204 -> getDocFromWebsli -> url:', url);
    const { filename, b64str } = get(queryType, 'data.wtDocs.wtDoc[0]', {});
    return { filename, b64str };
  } catch (error) {
    console.info('🙂 -> file: pod-doc-sender.js:207 -> getDocFromWebsli -> error:', error);
    const message = get(error, 'response.data', '');
    console.error('error while calling websli endpoint: ', message === '' ?? error.message);
    throw error;
  }
}

async function sendToCW(postData) {
  try {
    const config = {
      url: process.env.CW_URL,
      method: 'post',
      headers: {
        Authorization: process.env.CW_ENDPOINT_AUTHORIZATION,
      },
      data: postData,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    throw new Error(`CARGOWISE API Request Failed: ${res}`);
  } catch (error) {
    console.error('CARGOWISE API Request Failed: ', error);
    throw error;
  }
}

async function payloadToCW(b64str, filename, referenceNo) {
  try {
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
    return builder.buildObject(xmlData);
  } catch (error) {
    console.error('Error in trackingShipmentPayload:', error);
    throw error;
  }
}
