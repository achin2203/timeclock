// AWS Lambda entry point (used behind a Lambda function URL).
const serverless = require('serverless-http');
const { createApp } = require('./server');

module.exports.handler = serverless(createApp(), { binary: ['image/*', 'application/octet-stream'] });
