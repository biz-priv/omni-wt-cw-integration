'use strict';

const AWS = require('aws-sdk');
const { get } = require('lodash');
const { STATUSES, tableStatuses, publishToSNS } = require('./helper');
const {
  insertIntoDocStatusTable,
  getShipemntHeaderData,
  getDataFromCustomerList,
  getDocStatusTableData,
  getReferencesData
} = require('./dynamodb');

let functionName;
module.exports.handler = async (event, context) => {
  functionName = get(context, 'functionName');
  console.info(
    '🙂 -> file: shipment-file-stream-processor.js:4 -> module.exports.handler= -> event:',
    JSON.stringify(event)
  );

  await Promise.all(
    event.Records.map(async (record) => {
      const { body } = record;
      let { Message: message } = JSON.parse(body);
      message = JSON.parse(message);
      const tableData = AWS.DynamoDB.Converter.unmarshall(get(message, 'NewImage', {}));

      //* Extract required information
      console.info(
        '🙂 -> file: shipment-file-stream-processor.js:15 -> event.Records.map -> tableData:',
        tableData
      );
      const orderNo = get(tableData, 'FK_OrderNo');
      console.info(
        '🙂 -> file: shipment-file-stream-processor.js:17 -> event.Records.map -> orderNo:',
        orderNo
      );
      const docType = get(tableData, 'FK_DocType');
      console.info(
        '🙂 -> file: shipment-file-stream-processor.js:19 -> event.Records.map -> docType:',
        docType
      );
      const customerAccess = get(tableData, 'CustomerAccess');
      console.info(
        '🙂 -> file: shipment-file-stream-processor.js:21 -> event.Records.map -> customerAccess:',
        customerAccess
      );
      const fileExtension = get(tableData, 'FileName', '').split('.').pop();
      console.info(
        '🙂 -> file: shipment-file-stream-processor.js:23 -> event.Records.map -> fileExtension:',
        fileExtension
      );
      const originalTableStatuses = { ...tableStatuses };
      try {
        //* Check if the record is already sent or not
        const existingRecord = await getDocStatusTableData({ orderNo });
        if (existingRecord.length > 0) {
          console.info('Record already exists. Skipping.');
          return 'Record already exists. Skipping.';
        }

        //* Check if the customer has access to the file or not
        if (customerAccess !== 'Y') {
          console.info('Customer does not has access to the file.');
          return 'Customer does not has access to the file.';
        }

        //* Get shipment header data to check the bill number
        const shipmentHeaderData = await getShipemntHeaderData({ orderNo });
        console.info(
          '🙂 -> file: shipment-file-stream-processor.js:34 -> event.Records.map -> shipmentHeaderData:',
          shipmentHeaderData
        );
        const referencesData = await getReferencesData({ orderNo })
        if (referencesData === 0) {
          await insertIntoDocStatusTable({
            orderNo,
            docType,
            functionName,
            message: '',
            status: STATUSES.PENDING,
            fileExtension,
            tableStatuses,
            refNumber: get(referencesData, '[0].ReferenceNo', ''),
          });
          console.info('References data is not found. Skipping.');
          return 'References data is not found. Skipping.';
        }
        const refNumber = get(referencesData, '[0].ReferenceNo', '')
        if (shipmentHeaderData.length === 0) {
          await insertIntoDocStatusTable({
            orderNo,
            docType,
            functionName,
            message: '',
            status: STATUSES.PENDING,
            fileExtension,
            tableStatuses,
            refNumber,
          });
          console.info('Shipment header data is not found. Skipping.');
          return 'Shipment header data is not found. Skipping.';
        }
        const billNo = get(shipmentHeaderData, '[0].BillNo');
        console.info(
          '🙂 -> file: shipment-file-stream-processor.js:36 -> event.Records.map -> billNo:',
          billNo
        );

        const houseBill = get(shipmentHeaderData, '[0].Housebill');
        console.info(
          '🙂 -> file: shipment-file-stream-processor.js:95 -> event.Records.map -> houseBill:',
          houseBill
        );

        //* If bill no does not exists in the shipment header that means the data is faulty. Skip the record.
        if (billNo) {
          //* Get data from customer list to check if the document type is allowed or not. If not allowed, skip the record.

          const customerListData = await getDataFromCustomerList({ billNo });
          console.info(
            '🙂 -> file: shipment-file-stream-processor.js:38 -> event.Records.map -> customerListData:',
            customerListData
          );
          if (customerListData.length === 0) {
            console.info('Customer is not fourkites. Skipping.');
            return 'Customer is not fourkites. Skipping.';
          }
        } else {
          console.info('BillNo is not found. Skipping.');
          return 'BillNo is not found. Skipping.';
        }

        if (shipmentHeaderData.length > 0) {
          originalTableStatuses.SHIPMENT_HEADER_TABLE = STATUSES.READY;
        }

        const finalStatus = Object.values(originalTableStatuses).every(
          (status) => status === STATUSES.READY
        )
          ? STATUSES.READY
          : STATUSES.PENDING;
  
        //* Insert the record into the doc status table. If all the tables are ready, set the status to ready. If not, set the status to pending.
        await insertIntoDocStatusTable({
          orderNo,
          docType,
          functionName,
          message: '',
          status: finalStatus,
          fileExtension,
          tableStatuses: originalTableStatuses,
          billNo,
          houseBill,
          refNumber
        });
        return true;
      } catch (error) {
        console.info(
          '🙂 -> file: shipment-file-stream-processor.js:20 -> event.Records.map -> error:',
          error
        );
        await insertIntoDocStatusTable({
          orderNo,
          docType,
          functionName,
          message: error.message,
          status: STATUSES.FAILED,
          fileExtension,
          tableStatuses,
        });
        await publishToSNS(
          `OrderId: ${orderNo}, DocType: ${docType}\n${error.message}\n`,
          functionName
        );
        return false;
      }
    })
  );
  return true;
};