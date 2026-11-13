// npm run test:e2e
// Starts the test stack, runs test/e2e.test.mjs against it and removes the
// stack again. The tests restart n8n four times, once per further file
// in test/configs/. Set KEEP_STACK=1 to leave the last one running, for example
// to open the n8n editor on http://localhost:55697 and look at the executions.
//
//   N8N_IMAGE=n8nio/n8n:2.47.7 npm run test:e2e      another n8n version

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = ['compose', '--env-file', 'test/test.env', '-f', 'docker-compose.yml', '-f', 'test/docker-compose.yml', '-f', 'test/configs/filesystem.yml', '-p', 'eperm-test'];
const image = process.env.N8N_IMAGE ?? 'n8nio/n8n:2.43.7';
const env = { ...process.env, N8N_VERSION: process.env.N8N_VERSION ?? image.split(':')[1] };
const run = (command, args) => spawnSync(command, args, { cwd: root, stdio: 'inherit', env }).status ?? 1;

// Taking the stack down names the read-only config too, so its volume goes.
const down = [...compose.slice(0, -2), '-f', 'test/configs/readonly.yml', '-p', 'eperm-test', 'down', '-v'];

run('docker', down);
let status = run('docker', [...compose, 'up', '-d']);
if (status === 0) status = run(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', 'test/e2e.test.mjs']);
if (status !== 0) run('docker', [...compose, 'logs', '--tail', '60', 'n8n']);
if (!process.env.KEEP_STACK) run('docker', down);
process.exit(status);
