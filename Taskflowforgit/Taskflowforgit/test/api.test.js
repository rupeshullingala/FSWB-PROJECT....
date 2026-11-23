import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

// Needs a MongoDB to talk to: a local mongod works (default below), or point MONGODB_URI at any test cluster.
// Every run uses its own throw-away database, which is dropped at the end.
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017';
process.env.MONGODB_DB = `taskflow_test_${Date.now()}`;
process.env.JWT_SECRET = 'test-secret';
process.env.CRON_SECRET = 'cron-secret';

// Fake SMTP server that records what it receives.
const received = [];
const smtp = net.createServer((s) => {
  let inData = false, buf = '', msg = '';
  s.write('220 fake\r\n');
  s.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') { inData = false; received.push(msg); msg = ''; s.write('250 ok\r\n'); } else msg += line + '\n';
      } else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); }
      else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
      else if (line.startsWith('EHLO')) s.write('250 hi\r\n');
      else if (line === 'AUTH LOGIN') s.write('334 VXNlcm5hbWU6\r\n');
      else if (/^[A-Za-z0-9+/=]+$/.test(line)) s.write(line.length > 20 ? '235 ok\r\n' : '334 UGFzc3dvcmQ6\r\n');
      else s.write('250 ok\r\n');
    }
  });
});

let base;
let server, runReminders, mongo;
before(async () => {
  await new Promise((r) => smtp.listen(0, r));
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(smtp.address().port);
  process.env.MAIL_FROM = 'TaskFlow <noreply@test>';
  ({ server } = await import('../server/index.js'));
  ({ runReminders } = await import('../server/reminders.js'));
  mongo = await import('../server/db.js');
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  smtp.close();
  await mongo.database.dropDatabase();
  await mongo.client.close();
});

const call = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie') };
};

const date = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('auth, projects, tasks, comments, permissions, reminders', async () => {
  // register + login
  const a = (await call('/api/auth/register', { method: 'POST', body: { name: 'Asha', email: 'asha@test.com', password: 'secret1' } })).data;
  const r = (await call('/api/auth/register', { method: 'POST', body: { name: 'Ravi', email: 'ravi@test.com', password: 'secret2' } })).data;
  assert.ok(a.token && r.token);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { name: 'X', email: 'asha@test.com', password: 'secret1' } })).status, 409);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'asha@test.com', password: 'wrong' } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'ASHA@test.com', password: 'secret1' } })).status, 200);
  assert.equal((await call('/api/state')).status, 401);
  assert.equal((await call('/api/state', { token: a.token + 'x' })).status, 401);

  // project with a known and an unknown member
  let s = (await call('/api/projects', { method: 'POST', token: a.token, body: { name: 'Site', memberEmails: ['ravi@test.com', 'ghost@test.com'] } })).data;
  assert.equal(s.projects.length, 1);
  assert.deepEqual(s.projects[0].members.map((m) => m.name).sort(), ['Asha', 'Ravi']);
  assert.match(s.warnings[0], /ghost@test.com/);
  const pid = s.projects[0].id;

  // task assigned to Ravi (emails him), with subtasks
  const ravi = s.projects[0].members.find((m) => m.name === 'Ravi').id;
  s = (await call('/api/tasks', { method: 'POST', token: a.token, body: { projectId: pid, title: 'Wireframe', assignee: ravi, deadline: date(1), priority: 'High', reminder: true, subtasks: [{ title: 'Sketch', done: false }] } })).data;
  assert.equal(s.tasks.length, 1);
  assert.equal(s.tasks[0].subtasks.length, 1);
  const tid = s.tasks[0].id;

  // Ravi sees the project; an outsider does not
  const o = (await call('/api/auth/register', { method: 'POST', body: { name: 'Out', email: 'out@test.com', password: 'secret3' } })).data;
  assert.equal((await call('/api/state', { token: r.token })).data.tasks.length, 1);
  assert.equal((await call('/api/state', { token: o.token })).data.projects.length, 0);
  assert.equal((await call(`/api/tasks/${tid}`, { method: 'DELETE', token: o.token })).status, 404);
  assert.equal((await call(`/api/tasks/${tid}/comments`, { token: o.token })).status, 404);

  // move + subtask toggle + activity
  s = (await call(`/api/tasks/${tid}/move`, { method: 'POST', token: r.token, body: { status: 'progress' } })).data;
  assert.equal(s.tasks[0].status, 'progress');
  assert.equal((await call(`/api/tasks/${tid}/move`, { method: 'POST', token: r.token, body: { status: 'bogus' } })).status, 400);
  s = (await call(`/api/tasks/${tid}/subtasks/${s.tasks[0].subtasks[0].id}/toggle`, { method: 'POST', token: r.token })).data;
  assert.equal(s.tasks[0].subtasks[0].done, true);
  assert.ok(s.activity.some((x) => x.text.includes('moved from To do to In progress') && x.by === 'Ravi'));

  // comments (Asha comments -> Ravi is emailed; Ravi cannot delete Asha's)
  let c = (await call(`/api/tasks/${tid}/comments`, { method: 'POST', token: a.token, body: { body: 'Please use the new logo' } })).data;
  assert.equal(c.comments.length, 1);
  assert.equal(c.tasks[0].commentCount, 1);
  assert.equal((await call(`/api/comments/${c.comments[0].id}`, { method: 'DELETE', token: r.token })).status, 403);
  assert.equal((await call(`/api/tasks/${tid}/comments`, { method: 'POST', token: a.token, body: { body: '  ' } })).status, 400);

  // assignee must be a member
  assert.equal((await call(`/api/tasks/${tid}`, { method: 'PATCH', token: a.token, body: { assignee: o.user.id } })).status, 400);

  // only the owner can add members / delete project
  assert.equal((await call(`/api/projects/${pid}/members`, { method: 'POST', token: r.token, body: { email: 'out@test.com' } })).status, 403);
  s = (await call(`/api/projects/${pid}/members`, { method: 'POST', token: a.token, body: { email: 'out@test.com' } })).data;
  assert.equal(s.projects[0].members.length, 3);
  assert.equal((await call(`/api/projects/${pid}`, { method: 'DELETE', token: r.token })).status, 403);

  // emails: assignment + comment went through SMTP; reminder goes out once per day
  const before = received.length;
  assert.ok(before >= 2, `expected assignment+comment emails, got ${before}`);
  assert.equal(await runReminders(), 1);
  assert.equal(await runReminders(), 0);
  assert.equal(received.length, before + 1);
  const last = Buffer.from(received.at(-1).split('\n\n')[1].replace(/\n/g, ''), 'base64').toString();
  assert.match(last, /Wireframe/);
  assert.match(last, /is due on/);

  // timed deadlines: far-future task is not reminded; 30 min away is; once it passes, an overdue email follows
  const soon = new Date(Date.now() + 30 * 60000).toISOString();
  const far = new Date(Date.now() + 10 * 86400000).toISOString();
  await call('/api/tasks', { method: 'POST', token: a.token, body: { projectId: pid, title: 'Far', assignee: ravi, deadline: far, reminder: true } });
  s = (await call('/api/tasks', { method: 'POST', token: a.token, body: { projectId: pid, title: 'Soon', assignee: ravi, deadline: soon, reminder: true } })).data;
  assert.equal(await runReminders(), 1);
  assert.equal(await runReminders(), 0);
  assert.equal(await runReminders(Date.now() + 2 * 3600000), 1); // "Soon" is now overdue (the other task was reminded already, "Far" still 10 days away)
  assert.equal(await runReminders(Date.now() + 2 * 3600000), 0);
  assert.equal((await call(`/api/tasks/${s.tasks.at(-1).id}`, { method: 'PATCH', token: a.token, body: { deadline: 'not a date' } })).status, 400);
  const re = (await call(`/api/tasks/${s.tasks.at(-1).id}`, { method: 'PATCH', token: a.token, body: { deadline: soon.replace(/\d\d:\d\d:\d\d\.\d+Z/, '23:59:00Z') } })).status;
  assert.equal(re, 200);

  // delete task and project cascade
  assert.equal((await call(`/api/tasks/${tid}`, { method: 'DELETE', token: a.token })).data.tasks.length, 2);
  assert.equal((await call(`/api/projects/${pid}`, { method: 'DELETE', token: a.token })).data.projects.length, 0);
});

test('JWT: structure, access vs refresh tokens, refresh cookie, logout', async () => {
  const reg = await call('/api/auth/register', { method: 'POST', body: { name: 'Jo', email: 'jo@test.com', password: 'secret1' } });
  const [h, p, sig] = reg.data.token.split('.');
  assert.ok(h && p && sig, 'access token has three JWT parts');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.type, 'access');
  assert.equal(claims.exp - claims.iat, 15 * 60);

  // refresh token lives in an HttpOnly cookie, never in the JSON body
  assert.match(reg.cookie, /^taskflow_refresh=[^;]+; HttpOnly; SameSite=Strict; Path=\/api\/auth/);
  const refresh = reg.cookie.split(';')[0].split('=')[1];

  // a refresh token is not accepted as an access token, and vice versa
  assert.equal((await call('/api/me', { token: refresh })).status, 401);
  const asCookie = (value) => ({ method: 'POST', headers: { Cookie: `taskflow_refresh=${value}` } });
  const refreshCall = (value) => fetch(base + '/api/auth/refresh', asCookie(value));
  assert.equal((await refreshCall(reg.data.token)).status, 401);

  // refresh gives a working access token
  const ok = await refreshCall(refresh);
  assert.equal(ok.status, 200);
  const fresh = (await ok.json()).token;
  assert.equal((await call('/api/me', { token: fresh })).data.user.email, 'jo@test.com');
  assert.equal((await fetch(base + '/api/auth/refresh', { method: 'POST' })).status, 401); // no cookie

  // "alg: none" and tampered payloads are rejected
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal((await call('/api/me', { token: `${none}.${p}.` })).status, 401);
  const forged = Buffer.from(JSON.stringify({ ...claims, sub: '1' })).toString('base64url');
  assert.equal((await call('/api/me', { token: `${h}.${forged}.${sig}` })).status, 401);

  // expired token
  const { createHmac } = await import('node:crypto');
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const expiredBody = `${h}.${b({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 })}`;
  const expired = `${expiredBody}.${createHmac('sha256', 'test-secret').update(expiredBody).digest('base64url')}`;
  assert.equal((await call('/api/me', { token: expired })).status, 401);

  // logout clears the cookie
  const out = await call('/api/auth/logout', { method: 'POST' });
  assert.match(out.cookie, /Max-Age=0/);
});

test('password recovery: sends a one-time expiring reset link and changes the password', async () => {
  const reg = await call('/api/auth/register', { method: 'POST', body: { name: 'Reset User', email: 'reset@test.com', password: 'oldpass1' } });
  assert.equal(reg.status, 200);
  const before = received.length;
  const requested = await call('/api/auth/forgot-password', { method: 'POST', body: { email: 'reset@test.com' } });
  assert.equal(requested.status, 200);
  assert.match(requested.data.message, /If an account exists/);
  assert.equal(received.length, before + 1);
  const mail = received.at(-1);
  const encoded = mail.split('\n\n').at(-1).replace(/\n/g, '');
  const body = Buffer.from(encoded, 'base64').toString();
  const token = body.match(/resetToken=([a-f0-9]{64})/)?.[1];
  assert.ok(token, 'reset email contains a 64-character token');

  const changed = await call('/api/auth/reset-password', { method: 'POST', body: { token, password: 'newpass123' } });
  assert.equal(changed.status, 200);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'reset@test.com', password: 'oldpass1' } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'reset@test.com', password: 'newpass123' } })).status, 200);
  assert.equal((await call('/api/auth/reset-password', { method: 'POST', body: { token, password: 'anotherpass123' } })).status, 400, 'reset token cannot be reused');
});

test('third-party API: weather is proxied, validated and cached', async () => {
  const { token } = (await call('/api/auth/login', { method: 'POST', body: { email: 'jo@test.com', password: 'secret1' } })).data;
  assert.equal((await call('/api/weather?city=Pune')).status, 401);

  const realFetch = globalThis.fetch;
  const hits = { geo: 0, forecast: 0 };
  const stub = (geo, forecast) => async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://geocoding-api.open-meteo.com/')) { hits.geo++; return geo(u); }
    if (u.startsWith('https://api.open-meteo.com/')) { hits.forecast++; return forecast(u); }
    return realFetch(url, opts);
  };
  const okGeo = () => new Response(JSON.stringify({ results: [{ name: 'Pune', country: 'India', latitude: 18.5, longitude: 73.8 }] }));
  const okForecast = () => new Response(JSON.stringify({ daily: {
    time: ['2026-11-05', '2026-11-06'], weather_code: [0, 63],
    temperature_2m_max: [31.4, 28.2], temperature_2m_min: [19.6, 20.1], precipitation_probability_max: [5, 80],
  } }));
  try {
    globalThis.fetch = stub(okGeo, okForecast);
    const first = await call('/api/weather?city=Pune', { token });
    assert.equal(first.status, 200);
    assert.equal(first.data.city, 'Pune');
    assert.deepEqual(first.data.days[1], { date: '2026-11-06', summary: 'Rain', max: 28, min: 20, rainChance: 80 });
    await call('/api/weather?city=pune', { token });
    assert.deepEqual(hits, { geo: 1, forecast: 1 }, 'second call is served from the cache');

    // unknown city -> 404; third party down -> 502; empty body (the failure seen with another API) -> 502, not a crash
    globalThis.fetch = stub(() => new Response(JSON.stringify({})), okForecast);
    assert.equal((await call('/api/weather?city=Nowhereville', { token })).status, 404);
    globalThis.fetch = stub(() => new Response('', { status: 200 }), okForecast);
    assert.equal((await call('/api/weather?city=Blank', { token })).status, 502);
    globalThis.fetch = stub(() => new Response(JSON.stringify({ results: [{ name: 'Mumbai', country: 'India', latitude: 19.07, longitude: 72.87 }] })), () => new Response('nope', { status: 500 }));
    assert.equal((await call('/api/weather?city=Mumbai', { token })).status, 502);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('cron route needs the secret', async () => {
  assert.equal((await call('/api/cron/reminders')).status, 401);
  assert.equal((await fetch(base + '/api/cron/reminders', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const ok = await fetch(base + '/api/cron/reminders', { headers: { Authorization: 'Bearer cron-secret' } });
  assert.equal(ok.status, 200);
  assert.equal(typeof (await ok.json()).processed, 'number');
});

test('email: Brevo HTTPS API is used when BREVO_API_KEY is set', async () => {
  const { sendMail, emailConfigured } = await import('../server/mailer.js');
  const realFetch = globalThis.fetch;
  const calls = [];
  const prev = { key: process.env.BREVO_API_KEY, from: process.env.MAIL_FROM };
  process.env.BREVO_API_KEY = 'brevo-key';
  process.env.MAIL_FROM = 'TaskFlow <me@example.com>';
  try {
    assert.equal(emailConfigured(), true);
    globalThis.fetch = async (url, opts) => {
      if (!String(url).startsWith('https://api.brevo.com/')) return realFetch(url, opts);
      calls.push({ url: String(url), opts });
      return new Response(JSON.stringify({ messageId: 'x' }), { status: 201 });
    };
    assert.equal(await sendMail({ to: 'team@test.com', subject: 'Hello', text: 'Body' }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(calls[0].opts.headers['api-key'], 'brevo-key');
    assert.deepEqual(JSON.parse(calls[0].opts.body), {
      sender: { name: 'TaskFlow', email: 'me@example.com' }, to: [{ email: 'team@test.com' }], subject: 'Hello', textContent: 'Body',
    });

    // a rejected request must not throw (the request that triggered the email still succeeds)
    globalThis.fetch = async () => new Response('{"message":"Sender not valid"}', { status: 400 });
    assert.equal(await sendMail({ to: 'team@test.com', subject: 'Hello', text: 'Body' }), false);
  } finally {
    globalThis.fetch = realFetch;
    prev.key === undefined ? delete process.env.BREVO_API_KEY : (process.env.BREVO_API_KEY = prev.key);
    process.env.MAIL_FROM = prev.from;
  }
});
