import { col, isDuplicateKey } from './db.js';
import { sendMail } from './mailer.js';

const HOUR = 3600000;

/** Deadline as a timestamp. "2026-11-05T09:30:00.000Z" is exact; a plain date means end of that day. */
export const deadlineMs = (d) => (d.includes('T') ? Date.parse(d) : Date.parse(`${d}T23:59:00`));

export const formatDeadline = (d) => fmt(deadlineMs(d));

const fmt = (ms) =>
  new Date(ms).toLocaleString('en-IN', {
    timeZone: process.env.TIMEZONE || 'Asia/Kolkata',
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });

/**
 * Email assignees once when a task enters its "due soon" window (REMINDER_LEAD_HOURS before the deadline,
 * default 48) and once more when it becomes overdue.
 */
export async function runReminders(now = Date.now()) {
  const lead = Number(process.env.REMINDER_LEAD_HOURS || 48) * HOUR;
  const tasks = await col.tasks
    .find({ reminder: true, status: { $ne: 'done' }, deadline: { $ne: '' }, assigneeId: { $ne: null } })
    .toArray();
  if (!tasks.length) return 0;

  const byId = (docs) => new Map(docs.map((d) => [String(d._id), d]));
  const projects = byId(await col.projects.find({ _id: { $in: tasks.map((t) => t.projectId) } }).toArray());
  const users = byId(await col.users.find({ _id: { $in: tasks.map((t) => t.assigneeId) } }).toArray());

  let sent = 0;
  for (const t of tasks) {
    const due = deadlineMs(t.deadline);
    if (Number.isNaN(due)) continue;
    const diff = due - now;
    const kind = diff < 0 ? 'overdue' : diff <= lead ? 'due-soon' : null;
    if (!kind) continue;
    const key = { taskId: t._id, kind, deadline: t.deadline };
    if (await col.reminderLog.findOne(key)) continue;
    const assignee = users.get(String(t.assigneeId));
    const project = projects.get(String(t.projectId));
    if (!assignee || !project) continue;

    const subject = kind === 'overdue'
      ? `Overdue: "${t.title}" was due ${fmt(due)}`
      : `Reminder: "${t.title}" is due ${fmt(due)}`;
    const line = kind === 'overdue'
      ? `Your task "${t.title}" in project "${project.name}" is overdue. It was due on ${fmt(due)}.`
      : `Your task "${t.title}" in project "${project.name}" is due on ${fmt(due)}.`;
    await sendMail({ to: assignee.email, subject, text: `Hi ${assignee.name},\n\n${line}\n\nOpen TaskFlow to update it.\n` });
    try {
      await col.reminderLog.insertOne({ ...key, sentAt: new Date().toISOString() });
    } catch (e) {
      if (!isDuplicateKey(e)) throw e; // another run logged it first
    }
    sent++;
  }
  if (sent) console.log(`[reminders] sent ${sent} reminder(s)`);
  return sent;
}

/** Long-running servers only. On Vercel there is no such thing, so a Vercel Cron job calls /api/cron/reminders instead. */
export function startReminderScheduler() {
  const minutes = Number(process.env.REMINDER_INTERVAL_MINUTES || 5);
  setTimeout(() => runReminders().catch(console.error), 5000);
  setInterval(() => runReminders().catch(console.error), minutes * 60000).unref();
}
