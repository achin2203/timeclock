# TimeClock

A mobile-first web app for clocking employees in and out, working out daily wages from an hourly rate, recording cash payments, and showing what each employee is still owed.

It runs in any phone browser and can be added to the home screen like an app. One Docker image holds the whole thing, and it runs on AWS App Runner with Amazon RDS (PostgreSQL).

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
npm run dev          # http://localhost:8080 — uses a local SQLite file
npm test             # end-to-end API tests
```

With no email or SMS service set up, development mode **shows the 6-digit login code on screen** and prints it to the console, so you can sign in with any phone number or email.

To run against Postgres the way production does: `docker compose up --build`

## Deploy to AWS

Recommended setup:

```
Phone browser ──HTTPS──▶ AWS App Runner (this container, auto-scaling, free TLS)
                              │  VPC connector
                              ▼
                       Amazon RDS for PostgreSQL (private)
                       Amazon SES (email codes) · Amazon SNS (SMS codes)
```

### 1. Database (RDS)
1. In the RDS console, create a **PostgreSQL 16** database. A `db.t4g.micro` instance is plenty. Set **Public access: No** and initial database name `timeclock`.
2. Write down the endpoint, user and password. Your connection string is:
   `postgres://USER:PASSWORD@ENDPOINT:5432/timeclock`

The app creates its tables automatically the first time it starts.

### 2. Push the container image
```bash
AWS_REGION=us-east-1 ./deploy/push-image.sh timeclock
```

### 3. Create the App Runner service
1. In App Runner, create a service. Source: **Container registry → Amazon ECR**, and choose `timeclock:latest`. Port: **8080**.
2. Set the environment variables listed in `.env.example`: `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET` (generate one with `openssl rand -hex 32`), plus your sign-in settings. Store `DATABASE_URL` and `JWT_SECRET` as **Secrets Manager** references, not plain text.
3. **Networking → Outgoing traffic: Custom VPC.** Add a VPC connector that uses the RDS VPC's **private subnets**, then allow the connector's security group on port 5432 in the RDS security group.
   - Once a VPC connector is attached, *all* outgoing traffic goes through your VPC. The app still has to reach SES, SNS, Google and Facebook, so those private subnets need a **NAT gateway**.
4. **Security → Instance role:** create a role that the App Runner tasks service (`tasks.apprunner.amazonaws.com`) can assume, and attach `deploy/apprunner-instance-policy.json` to it. This allows sending through SES and SNS.
5. Health check: HTTP path `/healthz`.
6. Optionally add a **custom domain** under the service's *Custom domains* tab. App Runner issues the HTTPS certificate.

To release an update, run `push-image.sh` again and deploy. You can also turn on automatic deployment from ECR.

### 4. Sign-in setup
- **Email (SES):** verify your sending domain or address in SES and request **production access** so you can email any address. Then set `SES_FROM_EMAIL`.
- **SMS (SNS):** in SNS → Text messaging, request to leave the **SMS sandbox**, set a monthly spend limit, and register an origination number. US numbers need **10DLC or toll-free registration**. Then set `SNS_SMS_ENABLED=true`. Set `DEFAULT_COUNTRY_CODE` to your country code; it is `1` for US and Canada.
- **Google:** in Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID (Web application)**. Add your App Runner URL or domain under *Authorized JavaScript origins*, then set `GOOGLE_CLIENT_ID`.
- **Facebook:** create an app at developers.facebook.com and add *Facebook Login for Web* with your domain. Then set `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET`.

When `NODE_ENV=production`, any sign-in method that isn't configured shows a clear error instead of falling back to development mode.

### Budget alternative: Amazon Lightsail
For a single small business, **Lightsail container service** (deploy the same image) plus a **Lightsail managed PostgreSQL** database costs a predictable monthly amount and needs no NAT gateway. Use the same environment variables. For SES and SNS, either give the app the credentials of an IAM user that has only the `apprunner-instance-policy.json` permissions (set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`), or use only Google sign-in.

## Project layout
```
src/server.js        Express app, security headers, static files
src/db.js            Postgres/SQLite connection and schema migrations
src/auth.js          OTP, Google and Facebook sign-in; session cookie
src/routes/api.js    Organizations, employees, clock, shifts, payments, CSV
src/notify.js        SES email and SNS SMS senders
public/              Mobile web app (no build step), PWA manifest, service worker
test/api.test.js     End-to-end tests (run against SQLite; also pass against Postgres)
deploy/              ECR push script and IAM policy for App Runner
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
