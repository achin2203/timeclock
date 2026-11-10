// Sends one-time login codes by email (Amazon SES) or SMS (Amazon SNS).
// When AWS sending isn't configured and NODE_ENV !== 'production', codes are logged
// to the console instead (and returned to the client) so you can develop locally.
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const region = process.env.AWS_REGION || 'us-east-1';
const FROM_EMAIL = process.env.SES_FROM_EMAIL;
const SMS_ENABLED = process.env.SNS_SMS_ENABLED === 'true';
const APP_NAME = process.env.APP_NAME || 'TimeClock';

let ses, sns;

function devMode() {
  return process.env.NODE_ENV !== 'production' && process.env.OTP_DEV_MODE !== 'false';
}

async function sendCode(kind, target, code) {
  const text = `${code} is your ${APP_NAME} sign-in code. It expires in 10 minutes.`;

  if (kind === 'email' && FROM_EMAIL) {
    ses ||= new SESClient({ region });
    await ses.send(
      new SendEmailCommand({
        Source: FROM_EMAIL,
        Destination: { ToAddresses: [target] },
        Message: {
          Subject: { Data: `${APP_NAME} sign-in code: ${code}` },
          Body: { Text: { Data: text } },
        },
      })
    );
    return { delivered: true };
  }

  if (kind === 'phone' && SMS_ENABLED) {
    sns ||= new SNSClient({ region });
    await sns.send(
      new PublishCommand({
        PhoneNumber: target,
        Message: text,
        MessageAttributes: { 'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' } },
      })
    );
    return { delivered: true };
  }

  if (devMode()) {
    console.log(`[dev] login code for ${target}: ${code}`);
    return { delivered: false, devCode: code };
  }

  const err = new Error(kind === 'email' ? 'Email sign-in is not configured' : 'SMS sign-in is not configured');
  err.status = 503;
  throw err;
}

module.exports = { sendCode, devMode };
