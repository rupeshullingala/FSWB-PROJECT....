# TaskFlow - Task Management System (v3)

Project and task management app: React (Vite) + Redux Toolkit + Tailwind CSS on the front end, a Node.js API with MongoDB (Atlas) on the back end, deployable to Vercel.

## Features
- **JWT authentication**: sign up / log in with email and password (scrypt-hashed). The API issues a 15-minute **access token** (kept in memory, sent as a Bearer header) and a 7-day **refresh token** (HttpOnly cookie) that silently renews the session
- **Redux Toolkit** state management: `auth`, `tasks` and `weather` slices with async thunks (`src/store/`)
- **Third-party API**: 7-day weather forecast from [Open-Meteo](https://open-meteo.com) (no key needed, any city), shown on the dashboard and mentioned in the task form when the deadline is within the forecast
- **Backend + database**: all data lives in MongoDB, shared by every team member
- Create projects and add team members (by the email they signed up with)
- Add tasks, assign them to members and set deadlines
- Kanban board (To do, In progress, In review, Done) with drag and drop
- Subtasks with progress count
- **Comments** on every task (open a task with *Edit*)
- **Deadlines with date and time**
- **Email reminders**: assignees are emailed once when a task is within `REMINDER_LEAD_HOURS` (default 48) of its deadline and once when it becomes overdue, when a task is assigned to them, and when someone comments on their task
- Activity history for every project, showing who did what

## Requirements
Node.js **20.12 or newer** and a MongoDB database: a free [MongoDB Atlas](https://www.mongodb.com/atlas) M0 cluster, or a local `mongod`.

### MongoDB setup (Atlas)
1. Create a free cluster, then **Database Access > Add New Database User** (username + password).
2. **Network Access > Add IP Address**. For Vercel use `0.0.0.0/0` (Vercel has no fixed IPs); the database user's password is what protects it, so make it long.
3. **Connect > Drivers**, copy the `mongodb+srv://...` string and replace `<password>` (URL-encode special characters in the password).
4. Put it in `.env` as `MONGODB_URI=...` (locally) and in Vercel's Environment Variables (hosted). Collections and indexes are created automatically on first start.

## Run locally
```bash
npm install
cp .env.example .env        # on Windows: copy .env.example .env
npm run dev                 # API on :4000 + Vite on :5173
```
Open http://localhost:5173, create an account, then create a project.
To invite a teammate, they must sign up first; then add them by email.

### Production style (one server)
```bash
npm run build
npm start                   # serves the app and the API on http://localhost:4000
```

## Email setup
Until email is configured, nothing is sent: reminders are only logged in the server console and saved in the `outbox` collection. (The "Send reminders now" button tells you when this is the case.) Choose one option.

### Option A: Brevo (HTTPS API, no SMTP) - recommended
Free plan: 300 emails a day, and you can email anyone once you verify one sender address (no domain needed).
1. Sign up at brevo.com.
2. **Senders, Domains & Dedicated IPs > Senders > Add a sender**: use your own email (e.g. your Gmail) and click the verification link Brevo emails you.
3. **SMTP & API > API Keys > Generate a new API key**, and copy it.
4. In `.env` (copy `.env.example` first), set:
```
BREVO_API_KEY=xkeysib-...your key...
MAIL_FROM="TaskFlow <the-address-you-verified@gmail.com>"
```
`MAIL_FROM` must be exactly the verified sender address, or Brevo rejects the email.
5. Restart the server (`npm run dev`); `.env` is only read at startup.
6. Create a task assigned to a teammate with a deadline a few minutes ahead and click **Send reminders now**. Check the teammate's inbox and spam folder. Assigning a task or commenting also sends an email.

On Vercel, add the same two variables under Settings > Environment Variables and redeploy. Emails sent from a Gmail address often land in spam at first; a verified domain improves that.

### Option B: SMTP (Gmail App password)
Used only when `BREVO_API_KEY` is empty. Turn on 2-Step Verification, create an App password (16 characters, no spaces), then set:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=your16characterpassword
MAIL_FROM="TaskFlow <you@gmail.com>"
```
Your normal Gmail password will not work. Any SMTP provider works the same way. Port 465 (TLS) is supported, as is a plain-text port for local test servers.

The server checks for due tasks every `REMINDER_INTERVAL_MINUTES` (default 5) when running locally.

## Tests
```bash
npm test
```
Runs end-to-end API tests against a MongoDB (a local `mongod` on 127.0.0.1:27017 by default, or set `MONGODB_URI`; each run uses a temporary database that is dropped afterwards): accounts, permissions, tasks, comments, emails (fake SMTP server, and Brevo with the API stubbed), JWT behaviour (expiry, tampering, refresh cookie), the weather proxy (with the external API stubbed) and the cron route.

## Project structure
```
server/   index.js (API routes) · db.js (MongoDB connection + collections) · auth.js · weather.js · mailer.js · reminders.js
src/      React app (api.js, store/, components/)
test/     API test
```

## Deploying to Vercel
Vercel functions have no persistent disk, so the hosted app talks to **MongoDB Atlas** (see MongoDB setup above).

1. Push the project to GitHub (`.env` and `data/` are git-ignored).
2. On vercel.com choose **Add New > Project**, import the repo and click **Deploy**. `vercel.json` already sets the build.
3. Under **Settings > Environment Variables** add:

   | Name | Value |
   |---|---|
   | `MONGODB_URI` | your Atlas connection string |
   | `MONGODB_DB` | `taskflow` (optional) |
   | `JWT_SECRET` | a long random string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
   | `CRON_SECRET` | another long random string |
   | `WEATHER_CITY` | default city, e.g. `Hyderabad` (optional) |
   | `BREVO_API_KEY`, `MAIL_FROM` | only if you want real emails (see Email setup) |
   | `TIMEZONE` | e.g. `Asia/Kolkata` (optional) |
4. **Redeploy** (Deployments > the latest one > Redeploy) so the new variables take effect, then open the URL, sign up and create a project.

**Reminders on Vercel**: there is no always-on server, so `vercel.json` registers a Vercel Cron job that calls `/api/cron/reminders` once a day (the Hobby plan allows daily jobs). The "Send reminders now" button still works any time.

## How it fits together
```
api/[...path].js   Vercel entry: every /api/* request runs server/index.js
server/            index.js (routes + handler) - db.js (MongoDB) - auth.js (JWT) - weather.js (3rd-party API)
src/store/         Redux Toolkit: authSlice, tasksSlice, weatherSlice
src/api.js         fetch wrapper: attaches the access token, refreshes it on 401
```


## Password recovery

TaskFlow supports one-time password reset links sent through the configured mail provider. Set `APP_URL` to the public frontend origin (for example, your Vercel production URL) so reset links return to the deployed app. Reset links expire after 30 minutes.
