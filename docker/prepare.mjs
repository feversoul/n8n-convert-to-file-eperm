// Used by bootstrap.sh inside the n8n container: writes the credential file
// and copies the workflows into one folder, named by workflow id, for the
// n8n CLI.
//   node prepare.mjs <output dir> <workflows dir>
//
// Optional environment:
//   STANDIN_URL   replaces http://standin:8080 (speech request and Telegram)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [out, source] = process.argv.slice(2);
const standin = process.env.STANDIN_URL ?? 'http://standin:8080';

// A Telegram credential whose Base URL is the stand-in. The token is made up.
const credentials = [{ id: 'epermLabTelegram', name: 'Lab Telegram (stand-in)', type: 'telegramApi', data: { accessToken: '000000:lab-token', baseUrl: standin } }];

mkdirSync(join(out, 'workflows'), { recursive: true });
writeFileSync(join(out, 'credentials.json'), JSON.stringify(credentials));
for (const file of readdirSync(source).filter((name) => name.endsWith('.json'))) {
  const text = readFileSync(join(source, file), 'utf8').replaceAll('http://standin:8080', standin);
  const workflow = JSON.parse(text);
  writeFileSync(join(out, 'workflows', `${workflow.id}.json`), JSON.stringify(workflow));
}
