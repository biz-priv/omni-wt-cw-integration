'use strict';

const AWS = require('aws-sdk');

const sqs = new AWS.SQS();
const { publishToSNS } = require('../../shared/dynamo');

exports.handler = async (event, context) => {
    console.info('event:', JSON.stringify(event));
    const queueUrl = process.env.QUEUE_URL;

    for (const record of event.Records) {
        const params = {
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(record),
            MessageGroupId: 's3-events-group',
            MessageDeduplicationId: record.s3.object.eTag
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
        }
    }

    return 'success';
};
