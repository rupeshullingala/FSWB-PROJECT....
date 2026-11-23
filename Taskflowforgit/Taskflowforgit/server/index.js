import './env.js';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { col, ObjectId, oid, same, isDuplicateKey } from './db.js';
import {
  hashPassword, verifyPassword, createAccessToken, createRefreshToken, verifyToken,
  refreshCookie, clearRefreshCookie, readRefreshCookie,
} from './auth.js';
import { getWeather, CityNotFound } from './weather.js';
import { sendMail, emailConfigured } from './mailer.js';
import { startReminderScheduler, runReminders, formatDeadline } from './reminders.js';

const PORT = Number(process.env.PORT || 4000);
const STAGES = ['todo', 'progress', 'review', 'done'];
const PRIORITIES = ['Low', 'Medium', 'High'];
const STAGE_LABEL = { todo: 'To do', progress: 'In progress', review: 'In review', done: 'Done' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const now = () => new Date().toISOString();

// ---------- helpers ----------
const publicUser = (u) => ({ id: String(u._id), name: u.name, email: u.email });
const byId = (docs) => new Map(docs.map((d) => [String(d._id), d]));

const log = (projectId, user, text) =>
  col.activity.insertOne({ projectId, userId: user._id, by: user.name, text, at: now() });

/** The project, if it exists and the user is a member of it (otherwise 404, so outsiders learn nothing). */
async function requireMember(projectId, userId) {
  const id = oid(String(projectId ?? ''));
  const project = id && (await col.projects.findOne({ _id: id, memberIds: userId }));
  if (!project) throw new HttpError(404, 'Project not found');
  return project;
}

async function loadTask(taskId, user) {
  const id = oid(taskId);
  const task = id && (await col.tasks.findOne({ _id: id }));
  if (!task) throw new HttpError(404, 'Task not found');
  const project = await requireMember(task.projectId, user._id);
  return { task, project };
}

function assertAssignee(project, assigneeId) {
  if (assigneeId && !project.memberIds.some((m) => same(m, assigneeId))) throw bad('Assignee must be a member of the project');
}

function toAssignee(v) {
  if (v === '' || v == null) return null;
  const id = oid(String(v));
  if (!id) throw bad('Invalid assignee');
  return id;
}

/** Removes tasks together with everything that hangs off them (MongoDB has no ON DELETE CASCADE). */
async function deleteTasks(taskIds) {
  if (!taskIds.length) return;
  await col.comments.deleteMany({ taskId: { $in: taskIds } });
  await col.reminderLog.deleteMany({ taskId: { $in: taskIds } });
  await col.tasks.deleteMany({ _id: { $in: taskIds } });
}

/** Everything the current user is allowed to see, in the shape the React app expects. */
async function snapshot(userId) {
  const projects = await col.projects.find({ memberIds: userId }).sort({ _id: 1 }).toArray();
  if (!projects.length) return { projects: [], tasks: [], activity: [] };
  const ids = projects.map((p) => p._id);

  const users = byId(await col.users.find({ _id: { $in: projects.flatMap((p) => p.memberIds) } }).toArray());
  const tasks = await col.tasks.find({ projectId: { $in: ids } }).sort({ _id: 1 }).toArray();
  const activity = await col.activity.find({ projectId: { $in: ids } }).sort({ _id: -1 }).limit(300).toArray();

  return {
    projects: projects.map((p) => ({
      id: String(p._id),
      name: p.name,
      ownerId: String(p.ownerId),
      members: p.memberIds.map((m) => users.get(String(m))).filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name)).map(publicUser),
    })),
    tasks: tasks.map((t) => ({
      id: String(t._id),
      projectId: String(t.projectId),
      title: t.title,
      description: t.description,
      assignee: t.assigneeId ? String(t.assigneeId) : '',
      deadline: t.deadline,
      priority: t.priority,
      status: t.status,
      reminder: Boolean(t.reminder),
      commentCount: t.commentCount ?? 0,
      subtasks: (t.subtasks ?? []).map((s) => ({ id: String(s.id), title: s.title, done: Boolean(s.done) })),
    })),
    activity: activity.map((a) => ({ id: String(a._id), projectId: String(a.projectId), text: a.text, at: a.at, by: a.by })),
  };
}

function cleanTaskInput(b, { partial }) {
  const out = {};
  if (!partial || b.title !== undefined) {
    const title = String(b.title ?? '').trim();
    if (!title) throw bad('Title is required');
    if (title.length > 200) throw bad('Title is too long');
    out.title = title;
  }
  if (b.description !== undefined) out.description = String(b.description).slice(0, 2000);
  if (b.deadline !== undefined) {
    const d = String(b.deadline);
    // Either a plain date, or an exact moment in UTC (what the browser sends when a time is chosen).
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(d) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(d);
    if (d && (!ok || Number.isNaN(Date.parse(d)))) throw bad('Deadline must be a valid date and time');
    out.deadline = d;
  }
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority)) throw bad('Invalid priority');
    out.priority = b.priority;
  }
  if (b.reminder !== undefined) out.reminder = Boolean(b.reminder);
  if (b.assignee !== undefined) out.assigneeId = toAssignee(b.assignee);
  return out;
}

/** Subtasks live inside their task document. Existing ids are kept so the UI does not lose track of them. */
function cleanSubtasks(list) {
  return (Array.isArray(list) ? list : []).slice(0, 50)
    .map((s) => ({ id: oid(String(s.id ?? '')) ?? new ObjectId(), title: String(s.title ?? '').trim().slice(0, 200), done: Boolean(s.done) }))
    .filter((s) => s.title);
}

// Emails are awaited: on Vercel the function is frozen as soon as the response is sent.
async function notifyAssigned(task, projectName, by) {
  if (!task.assigneeId || same(task.assigneeId, by._id)) return;
  const to = await col.users.findOne({ _id: task.assigneeId });
  if (!to) return;
  await sendMail({
    to: to.email,
    subject: `New task assigned: "${task.title}"`,
    text: `Hi ${to.name},\n\n${by.name} assigned you the task "${task.title}" in project "${projectName}".` +
      `${task.deadline ? `\nDeadline: ${formatDeadline(task.deadline)}` : ''}\n`,
  });
}

// ---------- routes ----------
// Each route: [method, regex, handler(ctx)] where ctx = { user, body, params, req, setCookie }.
// auth: false = public, true = needs a valid access token, 'cron' = needs the CRON_SECRET (Vercel Cron).
const routes = [];
const route = (method, path, auth, handler) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), auth, handler });

/** Issues the pair of tokens: access token in the JSON body, refresh token in an HttpOnly cookie. */
function session(user, setCookie) {
  setCookie(refreshCookie(createRefreshToken(user._id)));
  return { token: createAccessToken(user._id), user: publicUser(user) };
}

route('POST', '/api/auth/register', false, async ({ body, setCookie }) => {
  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!name) throw bad('Name is required');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email address');
  if (password.length < 6) throw bad('Password must be at least 6 characters');
  const user = { name: name.slice(0, 80), email, passwordHash: hashPassword(password), createdAt: now() };
  try {
    user._id = (await col.users.insertOne(user)).insertedId; // the unique index on email also guards against races
  } catch (e) {
    if (isDuplicateKey(e)) throw new HttpError(409, 'An account with this email already exists');
    throw e;
  }
  return session(user, setCookie);
});

route('POST', '/api/auth/login', false, async ({ body, setCookie }) => {
  const email = String(body.email ?? '').trim().toLowerCase();
  const user = await col.users.findOne({ email });
  if (!user || !verifyPassword(String(body.password ?? ''), user.passwordHash))
    throw new HttpError(401, 'Incorrect email or password');
  return session(user, setCookie);
});

// Password recovery: always return the same message so callers cannot discover registered emails.
route('POST', '/api/auth/forgot-password', false, async ({ body, req }) => {
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email address');
  const user = await col.users.findOne({ email });
  if (user) {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 30 * 60 * 1000);
    await col.passwordResets.deleteMany({ userId: user._id });
    await col.passwordResets.insertOne({ userId: user._id, tokenHash, createdAt, expiresAt });
    const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
    const resetUrl = `${appUrl}/?resetToken=${rawToken}`;
    const sent = await sendMail({
      to: user.email,
      subject: 'Reset your TaskFlow password',
      text: `Hi ${user.name},\n\nWe received a request to reset your TaskFlow password. Use this one-time link within 30 minutes:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    });
    if (!sent) console.error('[password-reset] email could not be sent');
  }
  return { message: 'If an account exists for that email, a password reset link has been sent.' };
});

route('POST', '/api/auth/reset-password', false, async ({ body }) => {
  const token = String(body.token ?? '');
  const password = String(body.password ?? '');
  if (!/^[a-f0-9]{64}$/i.test(token)) throw bad('This reset link is invalid or expired. Request a new one.');
  if (password.length < 8) throw bad('Password must be at least 8 characters');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const reset = await col.passwordResets.findOneAndDelete({ tokenHash, expiresAt: { $gt: new Date() } });
  if (!reset) throw new HttpError(400, 'This reset link is invalid or expired. Request a new one.');
  await col.users.updateOne({ _id: reset.userId }, { $set: { passwordHash: hashPassword(password), passwordChangedAt: now() } });
  await col.passwordResets.deleteMany({ userId: reset.userId });
  return { message: 'Your password has been reset. You can now log in with your new password.' };
});

// Trade the refresh-token cookie for a fresh access token (also rotates the refresh cookie).
route('POST', '/api/auth/refresh', false, async ({ req, setCookie }) => {
  const id = oid(verifyToken(readRefreshCookie(req), 'refresh'));
  const user = id && (await col.users.findOne({ _id: id }));
  if (!user) {
    setCookie(clearRefreshCookie());
    throw new HttpError(401, 'Please log in');
  }
  return session(user, setCookie);
});

route('POST', '/api/auth/logout', false, ({ setCookie }) => {
  setCookie(clearRefreshCookie());
  return { ok: true };
});

route('GET', '/api/me', true, ({ user }) => ({ user: publicUser(user) }));
route('GET', '/api/state', true, ({ user }) => snapshot(user._id));

// Third-party API: weather forecast from Open-Meteo (see weather.js). Proxied so the browser only talks to us.
route('GET', '/api/weather', true, async ({ query }) => {
  const city = String(query.get('city') || process.env.WEATHER_CITY || 'Hyderabad').trim().slice(0, 80);
  if (!city) throw bad('Enter a city');
  try {
    return await getWeather(city);
  } catch (e) {
    if (e instanceof CityNotFound) throw new HttpError(404, e.message);
    console.error('[weather]', e.message);
    throw new HttpError(502, 'Could not load the weather right now');
  }
});

route('POST', '/api/projects', true, async ({ user, body }) => {
  const name = String(body.name ?? '').trim();
  if (!name) throw bad('Project name is required');
  const emails = [...new Set((body.memberEmails ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  const unknown = [];
  const joined = [];
  const memberIds = [user._id];
  for (const email of emails) {
    const m = await col.users.findOne({ email });
    if (!m) { unknown.push(email); continue; }
    if (memberIds.some((x) => same(x, m._id))) continue;
    memberIds.push(m._id);
    joined.push(m.name);
  }
  const { insertedId } = await col.projects.insertOne({ name: name.slice(0, 100), ownerId: user._id, memberIds, createdAt: now() });
  await log(insertedId, user, `Project "${name.slice(0, 100)}" created`);
  for (const n of joined) await log(insertedId, user, `${n} joined the project`);
  return { ...(await snapshot(user._id)), activeProjectId: String(insertedId), warnings: unknown.map((e) => `${e} has no account yet`) };
});

route('DELETE', '/api/projects/:id', true, async ({ user, params }) => {
  const project = await requireMember(params.id, user._id);
  if (!same(project.ownerId, user._id)) throw new HttpError(403, 'Only the project owner can delete it');
  const taskIds = (await col.tasks.find({ projectId: project._id }).toArray()).map((t) => t._id);
  await deleteTasks(taskIds);
  await col.activity.deleteMany({ projectId: project._id });
  await col.projects.deleteOne({ _id: project._id });
  return snapshot(user._id);
});

route('POST', '/api/projects/:id/members', true, async ({ user, params, body }) => {
  const project = await requireMember(params.id, user._id);
  if (!same(project.ownerId, user._id)) throw new HttpError(403, 'Only the project owner can add members');
  const email = String(body.email ?? '').trim().toLowerCase();
  const m = await col.users.findOne({ email });
  if (!m) throw new HttpError(404, `No account found for ${email}. Ask them to sign up first.`);
  if (project.memberIds.some((x) => same(x, m._id))) throw bad(`${m.name} is already in this project`);
  await col.projects.updateOne({ _id: project._id }, { $addToSet: { memberIds: m._id } });
  await log(project._id, user, `${m.name} joined the project`);
  return snapshot(user._id);
});

route('POST', '/api/tasks', true, async ({ user, body }) => {
  const project = await requireMember(body.projectId, user._id);
  const data = cleanTaskInput(body, { partial: false });
  assertAssignee(project, data.assigneeId);
  const task = {
    projectId: project._id,
    title: data.title,
    description: data.description ?? '',
    assigneeId: data.assigneeId ?? null,
    deadline: data.deadline ?? '',
    priority: data.priority ?? 'Medium',
    status: 'todo',
    reminder: data.reminder ?? true,
    subtasks: cleanSubtasks(body.subtasks),
    commentCount: 0,
    createdAt: now(),
  };
  task._id = (await col.tasks.insertOne(task)).insertedId;
  const who = task.assigneeId ? (await col.users.findOne({ _id: task.assigneeId }))?.name : null;
  await log(project._id, user, `Task "${task.title}" created${who ? ` and assigned to ${who}` : ''}`);
  await notifyAssigned(task, project.name, user);
  return snapshot(user._id);
});

route('PATCH', '/api/tasks/:id', true, async ({ user, params, body }) => {
  const { task: old, project } = await loadTask(params.id, user);
  const data = cleanTaskInput(body, { partial: true });
  assertAssignee(project, data.assigneeId);
  const changes = { ...data };
  if (Array.isArray(body.subtasks)) changes.subtasks = cleanSubtasks(body.subtasks);
  if (Object.keys(changes).length) await col.tasks.updateOne({ _id: old._id }, { $set: changes });

  const assigneeChanged = data.assigneeId !== undefined && !same(data.assigneeId, old.assigneeId) && (data.assigneeId || old.assigneeId);
  if (assigneeChanged) {
    const n = data.assigneeId ? (await col.users.findOne({ _id: data.assigneeId }))?.name : 'nobody';
    await log(old.projectId, user, `"${old.title}" assigned to ${n}`);
  }
  if (data.deadline !== undefined && data.deadline !== old.deadline)
    await log(old.projectId, user, `Deadline of "${old.title}" set to ${data.deadline || 'none'}`);
  await log(old.projectId, user, `Task "${data.title ?? old.title}" updated`);
  if (data.assigneeId && assigneeChanged) await notifyAssigned({ ...old, ...changes }, project.name, user);
  return snapshot(user._id);
});

route('POST', '/api/tasks/:id/move', true, async ({ user, params, body }) => {
  const { task } = await loadTask(params.id, user);
  if (!STAGES.includes(body.status)) throw bad('Invalid stage');
  if (task.status !== body.status) {
    await col.tasks.updateOne({ _id: task._id }, { $set: { status: body.status } });
    await log(task.projectId, user, `"${task.title}" moved from ${STAGE_LABEL[task.status]} to ${STAGE_LABEL[body.status]}`);
  }
  return snapshot(user._id);
});

route('POST', '/api/tasks/:id/subtasks/:sid/toggle', true, async ({ user, params }) => {
  const { task } = await loadTask(params.id, user);
  const sub = (task.subtasks ?? []).find((s) => String(s.id) === params.sid);
  if (!sub) throw new HttpError(404, 'Subtask not found');
  const subtasks = task.subtasks.map((s) => (s === sub ? { ...s, done: !s.done } : s));
  await col.tasks.updateOne({ _id: task._id }, { $set: { subtasks } });
  await log(task.projectId, user, `Subtask "${sub.title}" ${sub.done ? 'reopened' : 'completed'}`);
  return snapshot(user._id);
});

route('DELETE', '/api/tasks/:id', true, async ({ user, params }) => {
  const { task } = await loadTask(params.id, user);
  await deleteTasks([task._id]);
  await log(task.projectId, user, `Task "${task.title}" deleted`);
  return snapshot(user._id);
});

// ----- comments -----
async function commentRows(taskId) {
  const comments = await col.comments.find({ taskId }).sort({ _id: 1 }).toArray();
  const users = byId(await col.users.find({ _id: { $in: comments.map((c) => c.userId) } }).toArray());
  return comments.map((c) => ({
    id: String(c._id), body: c.body, at: c.createdAt, author: users.get(String(c.userId))?.name ?? 'Unknown', userId: String(c.userId),
  }));
}

route('GET', '/api/tasks/:id/comments', true, async ({ user, params }) => {
  const { task } = await loadTask(params.id, user);
  return { comments: await commentRows(task._id) };
});

route('POST', '/api/tasks/:id/comments', true, async ({ user, params, body }) => {
  const { task } = await loadTask(params.id, user);
  const text = String(body.body ?? '').trim();
  if (!text) throw bad('Comment cannot be empty');
  if (text.length > 2000) throw bad('Comment is too long');
  await col.comments.insertOne({ taskId: task._id, userId: user._id, body: text, createdAt: now() });
  await col.tasks.updateOne({ _id: task._id }, { $inc: { commentCount: 1 } });
  await log(task.projectId, user, `Commented on "${task.title}"`);
  if (task.assigneeId && !same(task.assigneeId, user._id)) {
    const to = await col.users.findOne({ _id: task.assigneeId });
    if (to) await sendMail({
      to: to.email,
      subject: `New comment on "${task.title}"`,
      text: `Hi ${to.name},\n\n${user.name} commented on "${task.title}":\n\n${text}\n`,
    });
  }
  return { comments: await commentRows(task._id), ...(await snapshot(user._id)) };
});

route('DELETE', '/api/comments/:id', true, async ({ user, params }) => {
  const id = oid(params.id);
  const c = id && (await col.comments.findOne({ _id: id }));
  if (!c) throw new HttpError(404, 'Comment not found');
  const { task } = await loadTask(String(c.taskId), user);
  if (!same(c.userId, user._id)) throw new HttpError(403, 'You can only delete your own comments');
  await col.comments.deleteOne({ _id: c._id });
  await col.tasks.updateOne({ _id: task._id }, { $inc: { commentCount: -1 } });
  return { comments: await commentRows(task._id), ...(await snapshot(user._id)) };
});

// Manual trigger, handy for demos: sends today's reminder emails right now.
route('POST', '/api/reminders/run', true, async () => ({ processed: await runReminders(), configured: emailConfigured() }));

// Called by Vercel Cron (see vercel.json). Vercel sends "Authorization: Bearer <CRON_SECRET>".
route('GET', '/api/cron/reminders', 'cron', async () => ({ processed: await runReminders() }));

// ---------- server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  const dist = join(process.cwd(), 'dist');
  if (!existsSync(dist)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Frontend not built. Run "npm run build", or use "npm run dev" during development.');
  }
  let file = normalize(join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(dist)) { res.writeHead(403); return res.end(); }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html'); // SPA fallback
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

function readBody(req) {
  // Vercel may already have parsed the body for us.
  if (req.body !== undefined && req.body !== null && typeof req.on !== 'function') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(bad('Invalid JSON')); }
    });
  });
}

/** The one request handler. Node's http server uses it locally; api/[...path].js hands it to Vercel. */
export async function handler(req, res) {
  const cookies = [];
  const send = (status, obj) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
    });
    res.end(JSON.stringify(obj));
  };
  try {
    const url = new URL(req.url, 'http://x');
    const { pathname } = url;
    if (!pathname.startsWith('/api/')) return serveStatic(req, res);

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      let user = null;
      if (r.auth === 'cron') {
        const secret = process.env.CRON_SECRET;
        if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, 'Not allowed');
      } else if (r.auth) {
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const id = oid(verifyToken(token, 'access'));
        user = id && (await col.users.findOne({ _id: id }));
        if (!user) throw new HttpError(401, 'Please log in');
      }
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const result = await r.handler({
        user, body, params: m.groups ?? {}, req, query: url.searchParams, setCookie: (c) => cookies.push(c),
      });
      return send(200, result);
    }
    send(404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message });
    console.error(e);
    send(500, { error: 'Something went wrong on the server' });
  }
}

export const server = http.createServer(handler);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => {
    console.log(`TaskFlow server running on http://localhost:${PORT}`);
    startReminderScheduler();
  });
}
