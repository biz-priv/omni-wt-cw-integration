'use strict';

const axios = require('axios');
const { get } = require('lodash');

async function sendToWT(postData) {
  try {
    const config = {
      url: process.env.WT_URL,
      method: 'post',
      headers: {
        'Content-Type': 'text/xml',
        'soapAction': 'http://tempuri.org/AddNewShipmentV3',
      },
      data: postData,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    throw new Error(`\n\nWORLD TRAK API Request Failed: ${res}`);
  } catch (error) {
    console.error('WORLD TRAK API Request Failed: ', error);
    const errorMsg = get(error, 'response.data', error.message);
    throw new Error(`${errorMsg}.\n\nPayload: ${postData}.`);
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
    throw new Error(`\n\nCARGOWISE API Request Failed: ${res}`);
  } catch (error) {
    const errorMsg = get(error, 'response.data', error.message);
    throw new Error(`${errorMsg}\n Payload: ${postData}`);
  }
}

module.exports = {
  sendToCW,
  sendToWT,
};
