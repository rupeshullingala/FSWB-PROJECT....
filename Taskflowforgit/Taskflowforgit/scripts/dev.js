// Starts the API server and the Vite dev server together: npm run dev
import { spawn } from 'node:child_process';

const run = (cmd, args) => {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: true });
  p.on('exit', (code) => process.exit(code ?? 0));
  return p;
};
const children = [run('node', ['--watch', 'server/index.js']), run('npx', ['vite'])];
process.on('SIGINT', () => children.forEach((c) => c.kill()));
