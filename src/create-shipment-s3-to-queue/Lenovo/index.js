'use strict';

const AWS = require('aws-sdk');

const sqs = new AWS.SQS();
const { publishToSNS } = require('../../shared/dynamo');

exports.handler = async (event, context) => {
    const queueUrl = process.env.QUEUE_URL;

    for (const record of event.Records) {
        const params = {
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(record),
            MessageGroupId: 's3-events-group', // Group ID for FIFO queues
            MessageDeduplicationId: record.s3.object.eTag // Unique ID for deduplication
        };

        try {
            await sqs.sendMessage(params).promise();
            console.info(`Message for ${record.s3.object.key} sent successfully.`);
        } catch (error) {
            console.error('Error sending message to SQS FIFO queue', error);
            publishToSNS({
                message: `An error occurred in function ${context.functionName}.\n\nERROR DETAILS: ${error}.`,
                subject: `${context.functionName} failed`,
            });
            // You can choose to rethrow the error if you want to fail the entire Lambda execution in case of an error
            // throw new Error(`Failed to send message for ${record.s3.object.key}. Error: ${error.message}`);
        }
    }

    return 'success';
};
