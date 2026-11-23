import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// ---- passwords (scrypt, salted) ----
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

// ---- JSON Web Tokens (RFC 7519, HS256) ----
// Standard three-part tokens: base64url(header).base64url(payload).base64url(signature).
// Two kinds:
//   access  - short-lived (15 min), sent in the "Authorization: Bearer" header, kept in memory by the browser
//   refresh - long-lived (7 days), kept in an HttpOnly cookie, only used to get a new access token

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 7 * 24 * 3600;

function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.VERCEL) throw new Error('JWT_SECRET must be set as an environment variable on Vercel.');
  const path = 'data/.secret';
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  mkdirSync('data', { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

let secret;
const b64json = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const sign = (data) => createHmac('sha256', (secret ??= getSecret())).update(data).digest('base64url');
const HEADER = b64json({ alg: 'HS256', typ: 'JWT' });

function createToken(userId, type, ttl) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64json({ sub: String(userId), type, iat: now, exp: now + ttl });
  const unsigned = `${HEADER}.${payload}`;
  return `${unsigned}.${sign(unsigned)}`;
}

export const createAccessToken = (userId) => createToken(userId, 'access', ACCESS_TTL_SECONDS);
export const createRefreshToken = (userId) => createToken(userId, 'refresh', REFRESH_TTL_SECONDS);

/** Returns the user id (a 24-character hex string) if the token is genuine, unexpired and of the expected type; otherwise null. */
export function verifyToken(token, expectedType = 'access') {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const good = Buffer.from(sign(`${header}.${payload}`));
  const given = Buffer.from(sig);
  if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
  try {
    // Only accept the algorithm we sign with (blocks "alg: none" style tricks).
    if (JSON.parse(Buffer.from(header, 'base64url').toString()).alg !== 'HS256') return null;
    const { sub, type, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (type !== expectedType || !(exp > Date.now() / 1000)) return null;
    return typeof sub === 'string' && /^[0-9a-f]{24}$/i.test(sub) ? sub : null;
  } catch {
    return null;
  }
}

// ---- refresh-token cookie ----
const COOKIE = 'taskflow_refresh';
const secureFlag = () => (process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '');

export const refreshCookie = (token) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=${REFRESH_TTL_SECONDS}${secureFlag()}`;

export const clearRefreshCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=0${secureFlag()}`;

export function readRefreshCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}
