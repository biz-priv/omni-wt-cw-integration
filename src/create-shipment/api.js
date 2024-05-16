'use strict';

const xml2js = require('xml2js');

async function prepareWTpayload(xmlObj) {
  console.info('🚀 ~ file: api.js:7 ~ prepareWTpayload ~ xmlObj:', xmlObj);
  try {
    const xmlBuilder = new xml2js.Builder({
      render: {
        pretty: true,
        indent: '    ',
        newline: '\n',
      },
    });

    const xmlPayload = xmlBuilder.buildObject({
      'soap:Envelope': {
        '$': {
          'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
          'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema',
          'xmlns:soap': 'http://schemas.xmlsoap.org/soap/envelope/',
        },
        'soap:Header': {
          AuthHeader: {
            $: {
              xmlns: 'http://tempuri.org/',
            },
            UserName: process.env.wt_soap_username,
            Password: process.env.wt_soap_password,
          },
        },
        'soap:Body': {
          AddNewShipmentV3: {
            $: {
              xmlns: 'http://tempuri.org/',
            },
            oShipData: '',
          },
        },
      },
    });

    return xmlPayload;
  } catch (error) {
    console.error('Error While preparing payload: ', error);
    throw error;
  }
}

function payloadToCW(shipmentId) {
  try {
    const builder = new xml2js.Builder({
      headless: true,
      renderOpts: { pretty: true, indent: '    ' },
    });

    const xmlData = {
      UniversalShipment: {
        $: { 'xmlns:ns0': 'http://www.cargowise.com/Schemas/Universal/2011/11' },
        Shipment: {
          $: { xmlns: 'http://www.cargowise.com/Schemas/Universal/2011/11' },
          DataContext: {
            DataTargetCollection: {
              DataTarget: {
                Type: 'ForwardingShipment',
                Key: shipmentId,
              },
            },
          },
          AdditionalReferenceCollection: {
            $: {
              Content: 'Complete',
            },
            AdditionalReference: {
              Type: {
                Code: '',
              },
              ReferenceNumber: '',
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

module.exports = {
  prepareWTpayload,
  payloadToCW,
};
