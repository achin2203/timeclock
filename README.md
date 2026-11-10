# TimeClock

A mobile-first web app for clocking employees in and out, working out daily wages from an hourly rate, recording cash payments, and showing what each employee is still owed.

It runs in any phone browser and can be added to the home screen like an app. It runs on **AWS Lambda + Amazon DynamoDB**, so you pay only for actual use; a small team typically costs a few dollars a month or less.

## What it does

**For the owner or admin**
- Create an organization with its name, time zone and currency. One login can belong to several organizations.
- Add employees by **mobile number or email**, with an **hourly rate** and a role: Employee or Admin.
- **Team screen:** who is on the clock right now (with a live timer), each person's balance owed, and the total owed.
- **Employee screen:** balance owed (earned minus paid), daily totals, the list of shifts and the list of payments, filterable by 7, 30 or 90 days or all time.
- **Record cash payment:** has "Full balance" and "Half" shortcuts and shows the balance after the payment before you save. Bank transfer, check and other are also available.
- Clock someone in or out for them, add a shift they forgot to record, edit shift times or the rate, and delete shifts or payments.
- **CSV export** of every shift for payroll.

**For employees**
- One big **CLOCK IN / CLOCK OUT** button, with a live timer and running earnings while clocked in.
- Today's hours and pay, the balance they are owed, and a history of days, shifts and payments.

**Sign-in options**
- **Phone number** with a code sent by SMS through Amazon SNS.
- **Email** with a code sent through Amazon SES.
- **Continue with Google** and **Continue with Facebook**.
- An employee's account links itself automatically the first time they sign in with the phone number or email the admin entered. Google sign-in links through the matching email.

### How the money is worked out
- Wage for a shift = hours worked × the hourly rate **when that shift started**. Changing someone's rate affects their future shifts. When an admin edits the rate, they can also apply the new rate to a shift that is currently in progress.
- **Balance owed** = wages from all completed shifts − all payments. A negative balance means the employee was paid in advance.
- Daily totals use the organization's time zone. A shift that crosses midnight counts toward the day it started.
- Money is stored as whole cents, so totals have no rounding drift.
- The database refuses a second clock-in while a shift is open. Shifts that overlap for the same person are rejected.

## Run it locally

```bash
npm install
npm run dev          # http://localhost:8080 — uses an in-memory DynamoDB (data resets on restart)
npm test             # end-to-end API tests
```

With no email service set up, development mode **shows the 6-digit login code on screen** and prints it to the console, so you can sign in with any phone number or email.

## How it runs on AWS

```
Phone browser ──HTTPS──▶ Lambda function URL ──▶ AWS Lambda (Node.js 22, this app)
                                                   ├─▶ Amazon DynamoDB table "timeclock" (on-demand)
                                                   └─▶ Amazon SES (email sign-in codes)
```

Everything is billed per request, so idle time costs nothing. Lambda, DynamoDB and SES are all billed on use.

| Resource | Name |
|---|---|
| Lambda function (with public HTTPS function URL) | `timeclock` |
| DynamoDB table (on-demand, deletion protection, TTL on `ttl`) | `timeclock` |
| IAM role for the function | `timeclock-lambda` |
| CodeBuild project (builds `dist/lambda.zip` from this repo) | `timeclock-build` |
| S3 bucket for build output | `timeclock-deploy-<account>-<region>` |

### Releasing an update
1. Push to `main`.
2. Start a build of the `timeclock-build` CodeBuild project. It runs the tests and writes `lambda.zip` to the deploy bucket.
3. Point the `timeclock` function at the new zip (Lambda → *Upload from Amazon S3*, or `aws lambda update-function-code`).

You can also build locally with `./deploy/build-lambda.sh`, which creates `dist/lambda.zip`.

### Configuration
Lambda environment variables are listed in `.env.example`.

### Data layout
A single DynamoDB table holds everything. Keys are `pk` / `sk`, and every read is strongly consistent, so the table needs no indexes. See the top of `src/db.js` for the item layout.

### Sign-in setup
- **Email (SES):** verify a sending address or domain, then set `SES_FROM_EMAIL`. A new SES account is in the *sandbox*: it only sends to verified addresses until you request production access in the SES console.
- **Google:** in Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID (Web application)**. Add the function URL under *Authorized JavaScript origins*, then set `GOOGLE_CLIENT_ID`.
- **SMS:** set `SNS_SMS_ENABLED=true` only if your AWS account allows Amazon SNS SMS. Leaving the SMS sandbox and registering an origination number are also required.

## Project layout
```
src/server.js        Express app, security headers, static files; local dev server
src/lambda.js        AWS Lambda entry point
src/db.js            DynamoDB data access (single table)
src/auth.js          OTP, Google and Facebook sign-in; session cookie
src/routes/api.js    Organizations, employees, clock, shifts, payments, CSV
src/notify.js        SES email and SNS SMS senders
public/              Mobile web app (no build step), PWA manifest, service worker
test/api.test.js     End-to-end tests against an in-memory DynamoDB
deploy/              Lambda packaging script
buildspec.yml        AWS CodeBuild build steps
```

## Security notes
- Sessions use an httpOnly, SameSite=Lax, Secure cookie that holds a signed JWT. Requests that change data must be JSON, which blocks cross-site form posts.
- Login codes are stored hashed, expire after 10 minutes, allow 5 attempts, and are rate-limited per IP. A new code can be requested every 30 seconds.
- Every organization endpoint checks that you belong to that organization. Team, pay and shift edits require the Admin or Owner role. Employees can see only their own records.

## Ideas for later
- Overtime rules (for example 1.5× after 40 hours a week) and pay periods with "close period" locks
- GPS or geofenced clock-in, or a photo at clock-in
- A shared kiosk mode (one tablet at the door, employees enter a PIN)
- Payslips or receipts sent by SMS or WhatsApp after each payment
