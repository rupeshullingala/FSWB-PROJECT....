// Vercel serverless entry point: every /api/* request is handled by the same code that runs locally.
import { handler } from '../server/index.js';

export default handler;
