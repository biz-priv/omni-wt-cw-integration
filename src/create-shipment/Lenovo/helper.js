'use strict';

const { get } = require('lodash');
const xml2js = require('xml2js');
const Joi = require('joi');
const { trackingNotesAPICall } = require('./api');
const { xmlToJson } = require('../../shared/helper');


const attributeSourceMap = {
  forwardingShipmentKey: 'UniversalInterchange.Body.UniversalShipment.Shipment.DataContext.DataSourceCollection.DataSource[?(@.Type==="ForwardingShipment")].Key',
  referenceNumber: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.LocalProcessing.OrderNumberCollection.OrderNumber.OrderReference',
  shipperAddress1: 'UniversalInterchange.Body.UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ReceivingForwarderAddress")].Address1',
  shipperAddress2: 'UniversalInterchange.Body.UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ReceivingForwarderAddress")].Address2',
  shipperCity: 'UniversalInterchange.Body.UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ReceivingForwarderAddress")].City',
  shipperName: 'UniversalInterchange.Body.UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ReceivingForwarderAddress")].CompanyName',
  shipperZip: 'UniversalInterchange.Body.UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ReceivingForwarderAddress")].Postcode',
  shipperState: 'UniversalInterchange.Body.UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ReceivingForwarderAddress")].State._',
  shipperCountry: 'UniversalInterchange.Body.UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ReceivingForwarderAddress")].Country.Code',
  shipperEmail: 'UniversalInterchange.Body.UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ReceivingForwarderAddress")].Email',
  shipperPhone: 'UniversalInterchange.Body.UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ReceivingForwarderAddress")].Phone',
  shipperFax: 'UniversalInterchange.Body.UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ReceivingForwarderAddress")].Fax',
  consigneeAddress1: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ConsigneePickupDeliveryAddress")].Address1',
  consigneeAddress2: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ConsigneePickupDeliveryAddress")].Address2',
  consigneeCity: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ConsigneePickupDeliveryAddress")].City',
  consigneeName: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ConsigneePickupDeliveryAddress")].CompanyName',
  consigneeZip: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ConsigneePickupDeliveryAddress")].Postcode',
  consigneeState: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ConsigneePickupDeliveryAddress")].State._',
  consigneeCountry: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ConsigneePickupDeliveryAddress")].Country.Code',
  consigneeEmail: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ConsigneePickupDeliveryAddress")].Email',
  consigneeFax: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ConsigneePickupDeliveryAddress")].Fax',
  consigneePhone: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.OrganizationAddressCollection.OrganizationAddress[?(@.AddressType==="ConsigneePickupDeliveryAddress")].Phone',
  readyDate: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.LocalProcessing.LCLAvailable',
  readyTime: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.LocalProcessing.LCLAvailable',
  shipmentLines: 'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.PackingLineCollection.PackingLine',
};


async function extractData(dataObj) {
  console.info('🚀 ~ file: test.js:353 ~ extractData ~ dataObj:', JSON.stringify(dataObj));

  try {
    const packingLine = get(
      dataObj,
      'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.PackingLineCollection.PackingLine',
      []
    );

    const packingLineArray = Array.isArray(packingLine) ? packingLine : [packingLine];

    const readyDate = get(
      dataObj,
      'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.LocalProcessing.LCLAvailable'
    );

    const readyTime = readyDate;

    const referenceNumber = get(
      dataObj,
      'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.LocalProcessing.OrderNumberCollection.OrderNumber.OrderReference',
      ''
    );

    const dataSourceCollection = get(
      dataObj,
      'UniversalInterchange.Body.UniversalShipment.Shipment.DataContext.DataSourceCollection.DataSource',
      []
    );

    const organizationAddressForShipper = get(
      dataObj,
      'UniversalInterchange.Body.UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress',
      []
    );

    const forwardingShipmentKey = get(
      dataSourceCollection.find((dataSource) => dataSource.Type === 'ForwardingShipment'),
      'Key',
      ''
    );

    const shipperAddress = organizationAddressForShipper.find(
      (address) => address.AddressType === 'ReceivingForwarderAddress'
    );

    const organizationAddressForConsignee = get(
      dataObj,
      'UniversalInterchange.Body.UniversalShipment.Shipment.SubShipmentCollection.SubShipment.OrganizationAddressCollection.OrganizationAddress',
      []
    );

    const consigneeAddress = organizationAddressForConsignee.find(
      (address) => address.AddressType === 'ConsigneePickupDeliveryAddress'
    );

    const shipmentLineValues = packingLineArray.map((item) => ({
      GoodsDescription: get(item, 'GoodsDescription', ''),
      Height: (parseFloat(get(item, 'Height', 0)) * 0.393701).toFixed(5),
      Length: (parseFloat(get(item, 'Length', 0)) * 0.393701).toFixed(5),
      PackQty: get(item, 'PackQty', 0),
      PackType: get(item, 'PackType.Code', ''),
      Weight: (parseFloat(get(item, 'Weight', 0)) * 2.2046).toFixed(2),
      Width: (parseFloat(get(item, 'Width', 0)) * 0.393701).toFixed(5),
    }));

    return {
      forwardingShipmentKey,
      referenceNumber,
      customerNo: '17773',
      station: 'T04',
      shipperAddress1: get(shipperAddress, 'Address1', ''),
      shipperAddress2: get(shipperAddress, 'Address2', ''),
      shipperCity: get(shipperAddress, 'City', ''),
      shipperName: get(shipperAddress, 'CompanyName', ''),
      shipperZip: get(shipperAddress, 'Postcode', ''),
      shipperState: get(shipperAddress, 'State._', ''),
      shipperCountry: get(shipperAddress, 'Country.Code', ''),
      shipperEmail: get(shipperAddress, 'Email', ''),
      shipperPhone: get(shipperAddress, 'Phone', ''),
      shipperFax: get(shipperAddress, 'Fax', ''),
      consigneeAddress1: get(consigneeAddress, 'Address1', ''),
      consigneeAddress2: get(consigneeAddress, 'Address2', ''),
      consigneeCity: get(consigneeAddress, 'City', ''),
      consigneeName: get(consigneeAddress, 'CompanyName', ''),
      consigneeZip: get(consigneeAddress, 'Postcode', ''),
      consigneeState: get(consigneeAddress, 'State._', ''),
      consigneeCountry: get(consigneeAddress, 'Country.Code', ''),
      consigneeEmail: get(consigneeAddress, 'Email', ''),
      consigneeFax: get(consigneeAddress, 'Fax', ''),
      consigneePhone: get(consigneeAddress, 'Phone', ''),
      readyDate,
      readyTime,
      shipmentLines: shipmentLineValues,
    };
  } catch (error) {
    console.error('Error extracting data:', error);
    throw error;
  }
}

async function preparePayloadForWT(data) {
  try {
    // Validate the data object against the schema
    const validatedData = await validateData(data);
    // Prepare the payload
    const payload = {
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
            oShipData: {
              ReferenceList: {
                NewShipmentRefsV3: [
                  {
                    ReferenceNo: get(validatedData, 'forwardingShipmentKey', ''),
                    CustomerTypeV3: 'BillTo',
                    RefTypeId: 'SID',
                  },
                  {
                    ReferenceNo: get(validatedData, 'referenceNumber', ''),
                    CustomerTypeV3: 'BillTo',
                    RefTypeId: 'ORD',
                  },
                ],
              },
              ServiceLevel: 'EC',
              PayType: '3',
              ShipmentType: 'Shipment',
              Mode: 'Domestic',
              DeclaredType: 'LL',
              CustomerNo: get(validatedData, 'customerNo', ''),
              BillToAcct: get(validatedData, 'customerNo', ''),
              Station: get(validatedData, 'station', ''),
              ShipperAddress1: get(validatedData, 'shipperAddress1', ''),
              ShipperAddress2: get(validatedData, 'shipperAddress2', ''),
              ShipperCity: get(validatedData, 'shipperCity', ''),
              ShipperName: get(validatedData, 'shipperName', ''),
              ShipperCountry: get(validatedData, 'shipperCountry', ''),
              ShipperEmail: get(validatedData, 'shipperEmail', ''),
              ShipperFax: get(validatedData, 'shipperFax', ''),
              ShipperPhone: get(validatedData, 'shipperPhone', ''),
              ShipperZip: get(validatedData, 'shipperZip', ''),
              ShipperState: get(validatedData, 'shipperState', ''),
              ReadyDate: get(validatedData, 'readyDate', ''),
              ReadyTime: get(validatedData, 'readyTime', ''),
              ConsigneeAddress1: get(validatedData, 'consigneeAddress1', ''),
              ConsigneeAddress2: get(validatedData, 'consigneeAddress2', ''),
              ConsigneeCity: get(validatedData, 'consigneeCity', ''),
              ConsigneeName: get(validatedData, 'consigneeName', ''),
              ConsigneeCountry: get(validatedData, 'consigneeCountry', ''),
              ConsigneeEmail: get(validatedData, 'consigneeEmail', ''),
              ConsigneeFax: get(validatedData, 'consigneeFax', ''),
              ConsigneePhone: get(validatedData, 'consigneePhone', ''),
              ConsigneeZip: get(validatedData, 'consigneeZip', ''),
              ConsigneeState: get(validatedData, 'consigneeState', ''),
              ShipmentLineList: {
                NewShipmentDimLineV3: get(validatedData, 'shipmentLines', []).map((line) => ({
                  Description: get(line, 'GoodsDescription', '').substring(0,35),
                  Height: Number(get(line, 'Height', 0)).toFixed(5),
                  Length: Number(get(line, 'Length', 0)).toFixed(5),
                  DimUOMV3: 'in',
                  Pieces: get(line, 'PackQty', 0),
                  PieceType: get(line, 'PackType', ''),
                  Weigth: Number(get(line, 'Weight', 0)).toFixed(2),
                  WeightUOMV3: 'lb',
                  Width: Number(get(line, 'Width', 0)).toFixed(5),
                })),
              },
            },
          },
        },
      },
    };

    // Convert the payload to XML
    const xmlBuilder = new xml2js.Builder({
      render: {
        pretty: true,
        indent: '    ',
        newline: '\n',
      },
    });
    const xmlPayload = xmlBuilder.buildObject(payload);
    return xmlPayload;
  } catch (error) {
    console.error('Error preparing payload:', error);
    throw error;
  }
}

async function payloadToCW(shipmentId, housebill) {
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
                Code: 'WHB',
              },
              ReferenceNumber: housebill,
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

function generateError(attribute, sourcePath) {
  return new Error(`${attribute} is required. Please populate the attribute from the CW.\n SourcePath ${sourcePath}`);
}

function validateData(data) {
  const schema = Joi.object({
    forwardingShipmentKey: Joi.string().required().error(generateError('forwardingShipmentKey', attributeSourceMap.forwardingShipmentKey)),
    referenceNumber: Joi.string().required().error(generateError('referenceNumber', attributeSourceMap.referenceNumber)),
    customerNo: Joi.string().required().error(generateError('customerNo', '')),
    station: Joi.string().required().error(generateError('station', '')),
    shipperAddress1: Joi.string().required().error(generateError('shipperAddress1', attributeSourceMap.shipperAddress1)),
    shipperAddress2: Joi.string().allow('').optional(),
    shipperCity: Joi.string().required().error(generateError('shipperCity', attributeSourceMap.shipperCity)),
    shipperName: Joi.string().required().error(generateError('shipperName', attributeSourceMap.shipperName)),
    shipperCountry: Joi.string().required().error(generateError('shipperCountry', attributeSourceMap.shipperCountry)),
    shipperEmail: Joi.string().allow('').optional(),
    shipperFax: Joi.string().allow('').optional(),
    shipperPhone: Joi.string().allow('').optional(),
    shipperZip: Joi.string().required().error(generateError('shipperZip', attributeSourceMap.shipperZip)),
    shipperState: Joi.string().required().error(generateError('shipperState', attributeSourceMap.shipperState)),
    readyDate: Joi.string().required().error(generateError('readyDate', attributeSourceMap.readyDate)),
    readyTime: Joi.string().required().error(generateError('readyTime', attributeSourceMap.readyTime)),
    consigneeAddress1: Joi.string().required().error(generateError('consigneeAddress1', attributeSourceMap.consigneeAddress1)),
    consigneeAddress2: Joi.string().allow('').optional(),
    consigneeCity: Joi.string().required().error(generateError('consigneeCity', attributeSourceMap.consigneeCity)),
    consigneeName: Joi.string().required().error(generateError('consigneeName', attributeSourceMap.consigneeName)),
    consigneeCountry: Joi.string().required().error(generateError('consigneeCountry', attributeSourceMap.consigneeCountry)),
    consigneeEmail: Joi.string().allow('').optional(),
    consigneeFax: Joi.string().allow('').optional(),
    consigneePhone: Joi.string().allow('').optional(),
    consigneeZip: Joi.string().required().error(generateError('consigneeZip', attributeSourceMap.consigneeZip)),
    consigneeState: Joi.string().required().error(generateError('consigneeState', attributeSourceMap.consigneeState)),
    shipmentLines: Joi.array().items(Joi.object({
      GoodsDescription: Joi.string().required().error(generateError('GoodsDescription', 'PackingLine.GoodsDescription')),
      Height: Joi.number().required().error(generateError('Height', 'PackingLine.Height')),
      Length: Joi.number().required().error(generateError('Length', 'PackingLine.Length')),
      PackQty: Joi.number().required().error(generateError('PackQty', 'PackingLine.PackQty')),
      PackType: Joi.string().required().error(generateError('PackType', 'PackingLine.PackType')),
      Weight: Joi.number().required().error(generateError('Weight', 'PackingLine.Weight')),
      Width: Joi.number().required().error(generateError('Width', 'PackingLine.Width')),
    })).required().error(generateError('shipmentLines', attributeSourceMap.shipmentLines)),
  });

  return schema.validateAsync(data, { abortEarly: false });
}

async function checkHousebillExists(referenceNo) {
  try {
    const builder = new xml2js.Builder({
      headless: true,
    });

    const payload = builder.buildObject({
      'soap:Envelope': {
        '$': {
          'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
          'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema',
          'xmlns:soap': 'http://schemas.xmlsoap.org/soap/envelope/'
        },
        'soap:Header': {
          'AuthHeader': {
            '$': {
              'xmlns': 'http://tempuri.org/'
            },
            'UserName': process.env.API_USER_ID,
            'Password': process.env.API_PASS
          }
        },
        'soap:Body': {
          'GetShipmentsByReferenceNo': {
            '$': {
              'xmlns': 'http://tempuri.org/'
            },
            'RefNo': referenceNo,
            'RefType': 'B'
          }
        }
      }
    });

    const xmlResponse = await trackingNotesAPICall(payload);
    const jsonResponse = await xmlToJson(xmlResponse);
    console.info('jsonResponse',JSON.stringify(jsonResponse));

    const shipmentDetails = get(jsonResponse, 'soap:Envelope.soap:Body.GetShipmentsByReferenceNoResponse.GetShipmentsByReferenceNoResult.ShipmentDetail', {});
    let housebill = '';
    if (Array.isArray(shipmentDetails)) {
      const housebills = shipmentDetails.map(detail => {
        const trackingNo = get(detail, 'TrackingNo', '');
        return trackingNo.length > 4 ? trackingNo.substring(4) : '';
      });

      const numericHousebills = housebills.map(housebillNo => parseInt(housebillNo, 10)).filter(Number.isFinite);

      housebill = numericHousebills.reduce((max, current) => {
        return current > max ? current : max;
      }, 0).toString();
    } else if (Object.keys(shipmentDetails).length > 0) {
      const trackingNo = get(shipmentDetails, 'TrackingNo', '');
      housebill = trackingNo.length > 4 ? trackingNo.substring(4) : '';
    } else {
      housebill = '';
    }

    return housebill;
  } catch (error) {
    console.error('Error in prepareCWpayload: ', error);
    throw error;
  }
}

async function payloadToAddTrakingNotesToWT(housebill, shipmentId) {
  try {
    const xmlData = `<?xml version="1.0"?>\n<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n<soap:Header>\n <AuthHeader\n xmlns="http://tempuri.org/">\n <UserName>${process.env.API_USER_ID}</UserName>\n <Password>${process.env.API_PASS}</Password>\n </AuthHeader>\n </soap:Header>\n <soap:Body>\n <WriteTrackingNote\n xmlns="http://tempuri.org/">\n <HandlingStation/>\n <HouseBill>${housebill}</HouseBill>\n <TrackingNotes>\n <TrackingNotes>\n <TrackingNoteMessage>&lt;a href="https://trxelpwebtracker.wisegrid.net/Login/Login.aspx?QuickViewNumber=${shipmentId}" target="_blank"&gt;${shipmentId}&lt;/a&gt;</TrackingNoteMessage>\n </TrackingNotes>\n </TrackingNotes>\n </WriteTrackingNote>\n </soap:Body>\n</soap:Envelope>\n`;
    return xmlData;
  } catch (error) {
    console.error('Error in payloadToAddTrakingNotesToWT:', error);
    throw error;
  }
}

module.exports = {
  preparePayloadForWT,
  payloadToCW,
  extractData,
  checkHousebillExists,
  payloadToAddTrakingNotesToWT
};
