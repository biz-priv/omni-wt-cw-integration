'use strict';

const { get } = require('lodash');
const xml2js = require('xml2js');

async function extractData(dataObj) {
  console.info('🚀 ~ file: test.js:353 ~ extractData ~ dataObj:', JSON.stringify(dataObj));

  try {
    const packingLine = get(
      dataObj,
      'UniversalShipment.Shipment.SubShipmentCollection.SubShipment.PackingLineCollection.PackingLine',
      []
    );

    const packingLineArray = Array.isArray(packingLine) ? packingLine : [packingLine];

    const readyDate = get(
      dataObj,
      'UniversalShipment.Shipment.SubShipmentCollection.SubShipment.LocalProcessing.LCLAvailable'
    );

    const readyTime = readyDate;

    const referenceNumber = get(
      dataObj,
      'UniversalShipment.Shipment.SubShipmentCollection.SubShipment.LocalProcessing.OrderNumberCollection.OrderNumber.OrderReference',
      ''
    );

    const dataSourceCollection = get(
      dataObj,
      'UniversalShipment.Shipment.DataContext.DataSourceCollection.DataSource',
      []
    );

    const organizationAddressForShipper = get(
      dataObj,
      'UniversalShipment.Shipment.OrganizationAddressCollection.OrganizationAddress',
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
      'UniversalShipment.Shipment.SubShipmentCollection.SubShipment.OrganizationAddressCollection.OrganizationAddress',
      []
    );

    const consigneeAddress = organizationAddressForConsignee.find(
      (address) => address.AddressType === 'ConsignorPickupDeliveryAddress'
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
                    ReferenceNo: get(data, 'forwardingShipmentKey', ''),
                    CustomerTypeV3: 'BillTo',
                    RefTypeId: 'SID',
                  },
                  {
                    ReferenceNo: get(data, 'referenceNumber', ''),
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
              CustomerNo: get(data, 'customerNo', ''),
              BillToAcct: get(data, 'customerNo', ''),
              Station: get(data, 'station', ''),
              ShipperAddress1: get(data, 'shipperAddress1', ''),
              ShipperAddress2: get(data, 'shipperAddress2', ''),
              ShipperCity: get(data, 'shipperCity', ''),
              ShipperName: get(data, 'shipperName', ''),
              ShipperCountry: get(data, 'shipperCountry', ''),
              ShipperEmail: get(data, 'shipperEmail', ''),
              ShipperFax: get(data, 'shipperFax', ''),
              ShipperPhone: get(data, 'shipperPhone', ''),
              ShipperZip: get(data, 'shipperZip', ''),
              ShipperState: get(data, 'shipperState', ''),
              ReadyDate: get(data, 'readyDate', ''),
              ReadyTime: get(data, 'readyTime', ''),
              ConsigneeAddress1: get(data, 'consigneeAddress1', ''),
              ConsigneeAddress2: get(data, 'consigneeAddress2', ''),
              ConsigneeCity: get(data, 'consigneeCity', ''),
              ConsigneeName: get(data, 'consigneeName', ''),
              ConsigneeCountry: get(data, 'consigneeCountry', ''),
              ConsigneeEmail: get(data, 'consigneeEmail', ''),
              ConsigneeFax: get(data, 'consigneeFax', ''),
              ConsigneePhone: get(data, 'consigneePhone', ''),
              ConsigneeZip: get(data, 'consigneeZip', ''),
              ConsigneeState: get(data, 'consigneeState', ''),
              ShipmentLineList: {
                NewShipmentDimLineV3: get(data, 'shipmentLines', []).map((line) => ({
                  Description: get(line, 'GoodsDescription', ''),
                  Height: Number(get(line, 'Height', 0)).toFixed(5),
                  Length: Number(get(line, 'Length', 0)).toFixed(5),
                  DimUOMV3: 'in',
                  Pieces: get(line, 'PackQty', 0),
                  PieceType: get(line, 'PackType', ''),
                  Weight: Number(get(line, 'Weight', 0)).toFixed(2),
                  WeightUOMV3: 'lb',
                  Width: Number(get(line, 'Width', 0)).toFixed(5),
                })),
              },
            },
          },
        },
      },
    };
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

module.exports = {
  preparePayloadForWT,
  payloadToCW,
  extractData,
};
