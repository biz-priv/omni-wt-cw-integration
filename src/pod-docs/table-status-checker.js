'use strict';

const { get } = require('lodash');
const { STATUSES, publishToSNS } = require('./helper');
const {
  getShipemntHeaderData,
  getDataFromCustomerList,
  getDocStatusTableDataByStatus,
  deleteDocStatusTableData,
  updateDocStatusTableData,
} = require('./dynamodb');

let functionName;
module.exports.handler = async (event, context) => {
  functionName = get(context, 'functionName');

  const existingRecord = await getDocStatusTableDataByStatus({ status: STATUSES.PENDING });
  console.info(
    '🙂 -> file: table-status-checker.js:20 -> module.exports.handler= -> existingRecord:',
    existingRecord
  );

  await Promise.all(
    existingRecord.map(async (record) => {
      const {
        OrderNo: orderNo,
        TableStatuses: tableStatuses,
        RetryCount: retryCount,
        DocType: docType,
      } = record;
      let billNo = null; //* To store the bill number. If not found, set the status of shipment header table as PENDING.
      let houseBill = null;
      const originalTableStatuses = { ...tableStatuses };
      try {
        if (tableStatuses.SHIPMENT_HEADER_TABLE === STATUSES.PENDING) {
          //* Get shipment header data to check the bill number
          const shipmentHeaderData = await getShipemntHeaderData({ orderNo });
          console.info(
            '🙂 -> file: shipment-file-stream-processor.js:34 -> event.Records.map -> shipmentHeaderData:',
            shipmentHeaderData
          );
          if (shipmentHeaderData.length > 0) {
            billNo = get(shipmentHeaderData, '[0].BillNo');
            console.info(
              '🙂 -> file: shipment-file-stream-processor.js:36 -> event.Records.map -> billNo:',
              billNo
            );

            houseBill = get(shipmentHeaderData, '[0].Housebill');
            console.info(
              '🙂 -> file: table-status-checker.js:48 -> existingRecord.map -> houseBill:',
              houseBill
            );

            if (billNo) {
              //* Get data from customer list to check if the document type is allowed or not. If not allowed, skip the record.
              const customerListData = await getDataFromCustomerList({ billNo });
              console.info(
                '🙂 -> file: shipment-file-stream-processor.js:38 -> event.Records.map -> customerListData:',
                customerListData
              );
              if (customerListData.length === 0) {
                console.info('Customer is not found. Deleting record.');
                await deleteDocStatusTableData({ docType, orderNo });
                return 'Customer is not found. Skipping.';
              }
            } else {
              //* If bill no does not exists in the shipment header that means the data is faulty. Skip the record.
              console.info('BillNo is not found. Skipping.');
              await updateDocStatusTableData({
                docType,
                functionName,
                message: 'BillNo is not found. Skipping.',
                orderNo,
                retryCount,
                status: STATUSES.FAILED,
                tableStatuses: originalTableStatuses,
              });
              return 'BillNo is not found. Skipping.';
            }
            originalTableStatuses.SHIPMENT_HEADER_TABLE = STATUSES.READY;
          }
        }

        const finalStatus = Object.values(originalTableStatuses).every(
          (status) => status === STATUSES.READY
        )
          ? STATUSES.READY
          : STATUSES.PENDING;

        if (finalStatus === STATUSES.PENDING && retryCount >= 5) {
          throw new Error(`All tables are not populated for order no ${orderNo}. `);
        }

        //* Update the record of the doc status table. If all the tables are ready, set the status to ready. If not, set the status to pending.
        await updateDocStatusTableData({
          docType,
          functionName,
          message: '',
          orderNo,
          retryCount,
          status: finalStatus,
          tableStatuses: originalTableStatuses,
          billNo,
          houseBill,
        });

        return true;
      } catch (error) {
        console.info(
          '🙂 -> file: shipment-file-stream-processor.js:20 -> event.Records.map -> error:',
          error
        );
        await updateDocStatusTableData({
          docType,
          functionName,
          message: error.message,
          orderNo,
          retryCount,
          status: STATUSES.FAILED,
          tableStatuses: originalTableStatuses,
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
