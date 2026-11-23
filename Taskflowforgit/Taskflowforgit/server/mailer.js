import net from 'node:net';
import tls from 'node:tls';
import { col } from './db.js';

/**
 * Tiny dependency-free SMTP client.
 *  - SMTP_PORT=465 -> implicit TLS (Gmail, most providers)
 *  - any other port -> plain SMTP (local test servers such as Mailpit)
 * If BREVO_API_KEY is set, emails go through Brevo's HTTPS API instead (see brevoSend below).
 * If neither is set, emails are only written to the `outbox` table and the console.
 */

function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      // A reply ends on a line like "250 text" (code followed by a space, not a dash).
      if (last && /^\d{3} /.test(last) && buf.endsWith('\r\n')) {
        cleanup();
        const code = Number(last.slice(0, 3));
        code >= 400 ? reject(new Error(`SMTP ${last}`)) : resolve(buf);
      }
    };
    const onError = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('SMTP connection closed')); };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

async function cmd(socket, line) {
  socket.write(line + '\r\n');
  return readReply(socket);
}

const clean = (s) => String(s).replace(/[\r\n]+/g, ' ');

async function smtpSend({ to, subject, text }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.MAIL_FROM || user;

  const socket = await new Promise((resolve, reject) => {
    const s = port === 465
      ? tls.connect({ host, port, servername: host }, () => resolve(s))
      : net.connect({ host, port }, () => resolve(s));
    s.setTimeout(15000, () => s.destroy(new Error('SMTP timeout')));
    s.once('error', reject);
  });

  try {
    await readReply(socket); // greeting
    await cmd(socket, `EHLO taskflow.local`);
    if (user && pass) {
      await cmd(socket, 'AUTH LOGIN');
      await cmd(socket, Buffer.from(user).toString('base64'));
      await cmd(socket, Buffer.from(pass).toString('base64'));
    }
    const bare = (a) => (a.match(/<([^>]+)>/)?.[1] ?? a).trim();
    await cmd(socket, `MAIL FROM:<${bare(from)}>`);
    await cmd(socket, `RCPT TO:<${bare(to)}>`);
    await cmd(socket, 'DATA');
    const body = text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const message = [
      `From: ${clean(from)}`,
      `To: ${clean(to)}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body).toString('base64').replace(/(.{76})/g, '$1\r\n'),
      '.',
    ].join('\r\n');
    await cmd(socket, message);
    await cmd(socket, 'QUIT').catch(() => {});
  } finally {
    socket.destroy();
  }
}

const insertOutbox = (to, subject, body, status) =>
  col.outbox.insertOne({ to, subject, body, status, createdAt: new Date().toISOString() });

/**
 * Brevo (https://brevo.com) transactional email over HTTPS: no SMTP, so it also works where raw SMTP is awkward.
 * Used when BREVO_API_KEY is set. The sender is MAIL_FROM ("Name <address>"), which must be a sender verified in Brevo.
 */
async function brevoSend({ to, subject, text }) {
  const from = process.env.MAIL_FROM || '';
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const sender = m ? { name: m[1] || 'TaskFlow', email: m[2] } : { name: 'TaskFlow', email: from.trim() };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Brevo answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** True when some way of sending real email is set up (Brevo API key or SMTP server). */
export const emailConfigured = () => Boolean(process.env.BREVO_API_KEY || process.env.SMTP_HOST);

/** Never throws: a failed email must not break the request that triggered it. */
export async function sendMail({ to, subject, text }) {
  if (!emailConfigured()) {
    await insertOutbox(to, subject, text, 'logged (email not configured)');
    console.log(`[mail] (not sent, email not configured) to=${to} subject="${subject}"`);
    return false;
  }
  try {
    await (process.env.BREVO_API_KEY ? brevoSend : smtpSend)({ to, subject, text });
    await insertOutbox(to, subject, text, 'sent');
    return true;
  } catch (e) {
    await insertOutbox(to, subject, text, `failed: ${e.message}`);
    console.error(`[mail] failed to send to ${to}: ${e.message}`);
    return false;
  }
}
