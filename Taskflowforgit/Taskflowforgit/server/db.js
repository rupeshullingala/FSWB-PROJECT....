import { MongoClient, ObjectId } from 'mongodb';

/**
 * MongoDB connection (Atlas on Vercel, or a local mongod while developing).
 *
 * Collections (documents reference each other by ObjectId):
 *   users        { name, email (unique), passwordHash, createdAt }
 *   projects     { name, ownerId, memberIds: [userId], createdAt }
 *   tasks        { projectId, title, description, assigneeId|null, deadline, priority, status, reminder,
 *                  subtasks: [{ id, title, done }], commentCount, createdAt }
 *   comments     { taskId, userId, body, createdAt }
 *   activity     { projectId, userId, by, text, at }
 *   reminderLog  { taskId, kind, deadline, sentAt }   (unique on taskId + kind + deadline)
 *   outbox       { to, subject, body, status, createdAt }
 */

const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error(
    'MONGODB_URI is not set. Create a free MongoDB Atlas cluster (or run a local mongod), copy the connection string ' +
    'into .env locally, or into Vercel > Settings > Environment Variables, and restart/redeploy.',
  );
}

// A serverless function can be re-used for many requests, so keep ONE connection promise per process.
globalThis.__taskflowMongo ??= (async () => {
  const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const database = client.db(process.env.MONGODB_DB || 'taskflow');
  await Promise.all([
    database.collection('users').createIndex({ email: 1 }, { unique: true }),
    database.collection('projects').createIndex({ memberIds: 1 }),
    database.collection('tasks').createIndex({ projectId: 1 }),
    database.collection('comments').createIndex({ taskId: 1 }),
    database.collection('activity').createIndex({ projectId: 1, _id: -1 }),
    database.collection('reminderLog').createIndex({ taskId: 1, kind: 1, deadline: 1 }, { unique: true }),
    database.collection('passwordResets').createIndex({ tokenHash: 1 }, { unique: true }),
    database.collection('passwordResets').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  return { client, database };
})();

let connected;
try {
  connected = await globalThis.__taskflowMongo;
} catch (e) {
  delete globalThis.__taskflowMongo; // allow a retry on the next cold start
  throw e;
}

export const { client, database } = connected;

export const col = {
  users: database.collection('users'),
  projects: database.collection('projects'),
  tasks: database.collection('tasks'),
  comments: database.collection('comments'),
  activity: database.collection('activity'),
  reminderLog: database.collection('reminderLog'),
  outbox: database.collection('outbox'),
  passwordResets: database.collection('passwordResets'),
};

export { ObjectId };

/** A 24-character hex string -> ObjectId, anything else -> null (never throws). */
export const oid = (v) => (typeof v === 'string' || v instanceof ObjectId) && /^[0-9a-f]{24}$/i.test(String(v)) ? new ObjectId(String(v)) : null;

/** Compare two ids (ObjectId or string, null-safe). */
export const same = (a, b) => a != null && b != null && String(a) === String(b);

export const isDuplicateKey = (e) => e?.code === 11000;
