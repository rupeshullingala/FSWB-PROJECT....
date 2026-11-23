import { existsSync } from 'node:fs';

// Imported first so .env values are available to every other module.
if (existsSync('.env')) process.loadEnvFile('.env');
