// End-to-end tests (test/stack.sh or npm run test:e2e).
//
// Every case is a real workflow on a real n8n, started over its production
// webhook. A test asserts what the run did: the file Convert to File made
// (name, type, where it is stored, the bytes read back from storage), or the
// error the execution failed with, read from n8n's API.
//
// n8n is started five times on the same data volume, once per file in
// test/configs/: filesystem (n8n as shipped), memory, database, readonly,
// restricted.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.N8N_URL ?? 'http://localhost:55697';
const STANDIN = process.env.STANDIN_URL ?? 'http://localhost:58097';
const N8N_VERSION = process.env.N8N_VERSION ?? '2.43.7';
const OWNER = { email: 'owner@example.com', firstName: 'Lab', lastName: 'Owner', password: 'Lab-owner-1234' };

// The message from the thread, and the one n8n shows for the sibling code.
const EPERM = 'Operation not permitted, make sure you have the right permissions';
const EACCES = 'Forbidden by access permissions, make sure you have the right permissions';
const ENOENT = 'The file or directory does not exist';
const NOT_A_STRING = 'The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.';
// The node's base64 handling was rewritten after 2.43: the code of 2.45.6,
// 2.46.7 and 2.47.7 has its own message for a value that is not text and
// removes a data: URI prefix. 2.43.7 passes on Node's error and decodes the
// prefix. (2.44 was not looked at.)
const [MAJOR, MINOR] = N8N_VERSION.split('.').map(Number);
const REWRITTEN = MAJOR > 2 || MINOR >= 45;
const notText = (field, received) => (REWRITTEN ? `The value in "${field}" is not valid Base64 data` : `${NOT_A_STRING} ${received}`);
const brief = (message) => message.replace(NOT_A_STRING, 'The first argument must be of type string ...');
const STORAGE = '/home/node/.n8n/storage';
const STORED = /^filesystem-v2:workflows\/eperm-[a-z-]+\/executions\/\d+\/binary_data\/[0-9a-f-]{36}$/;
const GEMINI_PATH = 'candidates[0].content.parts[0].inlineData.data';
const MIB = 1024 * 1024;

const HELLO = { audio: 'aGVsbG8=', fileName: 'test.txt', mimeType: 'text/plain' };
const base64 = (bytes) => Buffer.from(bytes).toString('base64');

// --- sample audio ----------------------------------------------------------------

// A quarter second of a 440 Hz tone, 16-bit little-endian mono: headerless PCM.
function pcm(rate = 24000, seconds = 0.25) {
  const samples = Math.round(rate * seconds);
  const bytes = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  return bytes;
}

// Reads a WAV file the strict way: every field of the RIFF, fmt and data chunks.
function parseWav(bytes) {
  assert.equal(bytes.toString('latin1', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8, 'RIFF size is the file size minus 8');
  assert.equal(bytes.toString('latin1', 8, 12), 'WAVE');
  assert.equal(bytes.toString('latin1', 12, 16), 'fmt ');
  assert.equal(bytes.readUInt32LE(16), 16, 'fmt chunk size');
  const format = { format: bytes.readUInt16LE(20), channels: bytes.readUInt16LE(22), rate: bytes.readUInt32LE(24), byteRate: bytes.readUInt32LE(28), blockAlign: bytes.readUInt16LE(32), bits: bytes.readUInt16LE(34) };
  assert.equal(format.byteRate, (format.rate * format.channels * format.bits) / 8, 'byte rate matches rate, channels and bits');
  assert.equal(format.blockAlign, (format.channels * format.bits) / 8, 'block align matches channels and bits');
  assert.equal(bytes.toString('latin1', 36, 40), 'data');
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44, 'data size is everything after the header');
  return { ...format, samples: bytes.subarray(44) };
}

// The same samples with a header, built here and not by the workflow.
function wav(samples, rate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

// Base64 text with one of Node's error codes spelled inside it. 30 bytes give
// 40 characters, so the code starts on a 4-character boundary.
const carrying = (code) => `${base64(Buffer.alloc(30, 'x'))}${code}${'A'.repeat(8 - code.length)}`;

// --- talking to n8n --------------------------------------------------------------

let apiKey = '';
let cookie = '';
const report = [];
const note = (config, name, outcome) => report.push({ config, name, outcome });

const json = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
};

async function until(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(500);
  }
}

const api = async (path) => json(await fetch(`${BASE}/api/v1${path}`, { headers: { 'x-n8n-api-key': apiKey } }));
const rest = async (method, path, body) => {
  const response = await fetch(`${BASE}/rest${path}`, { method, headers: { cookie, 'browser-id': 'lab', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await json(response), headers: response.headers };
};

const post = (name, body) => fetch(`${BASE}/webhook/eperm/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const compose = (config) => ['compose', '--env-file', 'test/test.env', '-f', 'docker-compose.yml', '-f', 'test/docker-compose.yml', '-f', `test/configs/${config}.yml`, '-p', 'eperm-test'];
let current = 'filesystem';

// A shell command inside the n8n container. `root` also lifts the limits
// Docker puts on root (chattr needs that).
function inContainer(command, { root = false } = {}) {
  const done = spawnSync('docker', [...compose(current), 'exec', '-T', ...(root ? ['--privileged', '-u', 'root'] : []), 'n8n', 'sh', '-c', command], { cwd: ROOT, encoding: 'utf8' });
  return { status: done.status, out: `${done.stdout}${done.stderr}`.trim() };
}

// The port can accept connections before n8n answers, and n8n serves a
// "starting up" page first (200, plain text): wait for a workflow that needs
// no storage to answer with something else.
const answered = async (response) => response.status === 200 && !(await response.text()).startsWith('n8n is starting up');
const ready = () => until(async () => answered(await post('code-binary', HELLO)), 600_000);

// Restarts n8n with another file from test/configs/. The data volume stays,
// so workflows, the owner and the API key are the same.
async function configure(config) {
  current = config;
  const done = spawnSync('docker', [...compose(config), 'up', '-d', 'n8n'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  await until(async () => inContainer('echo $LAB_CONFIG').out === config, 60_000);
  await ready();
  await until(async () => Array.isArray((await api('/executions?limit=1')).data), 60_000);
}

// One production run: POST to the webhook of a case workflow. The webhook
// answers with the Result item; the execution is read back for its status and,
// when it failed, its error.
const seen = new Map();
async function run(name, body) {
  if (!seen.has(name)) seen.set(name, Number((await api(`/executions?workflowId=eperm-${name}&limit=1`)).data?.[0]?.id ?? 0));
  const response = await post(name, body);
  const answer = await json(response);
  const execution = await until(async () => {
    const newest = (await api(`/executions?workflowId=eperm-${name}&limit=1`)).data?.[0];
    return newest && newest.stoppedAt && Number(newest.id) > seen.get(name) ? newest : null;
  });
  seen.set(name, Number(execution.id));
  let error;
  if (execution.status !== 'success') error = (await api(`/executions/${execution.id}?includeData=true`)).data.resultData.error;
  return { http: response.status, answer, status: execution.status, error };
}

// The run made a file with these bytes; returns the Result item.
async function converted(name, body, bytes) {
  const result = await run(name, body);
  assert.equal(result.status, 'success', result.error?.message?.slice(0, 300));
  assert.equal(result.http, 200);
  if (bytes) assert.ok(Buffer.from(result.answer.back, 'base64').equals(bytes), 'the stored bytes are the decoded input');
  return result.answer;
}

// Convert to File failed; returns the error of the execution.
async function failed(name, body) {
  const result = await run(name, body);
  assert.equal(result.status, 'error');
  assert.equal(result.http, 500);
  assert.equal(result.error.node.name, 'Convert to File');
  assert.equal(result.error.name, 'NodeOperationError');
  return result.error;
}

before(async () => {
  await ready();
  // Owner and API key through n8n's own endpoints, the ones the first-run
  // screen and Settings > n8n API use. The webhooks can answer a moment
  // before the editor's API does.
  const response = await until(async () => {
    let attempt = await rest('POST', '/owner/setup', OWNER);
    if (attempt.status !== 200) attempt = await rest('POST', '/login', { emailOrLdapLoginId: OWNER.email, password: OWNER.password });
    return attempt.status === 200 ? attempt : null;
  }, 60_000);
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const key = await rest('POST', '/api-keys', { label: `lab-${Date.now().toString(36)}`, expiresAt: null, scopes: ['execution:read', 'execution:list', 'workflow:read', 'workflow:list'] });
  assert.equal(key.status, 200, JSON.stringify(key.body).slice(0, 300));
  apiKey = key.body.data.rawApiKey;
});

after(() => {
  const width = Math.max(...report.map((line) => line.name.length));
  console.log(`\nConvert to File, "Move Base64 String to File", n8n ${N8N_VERSION}.\n`);
  let config = '';
  for (const line of report) {
    if (line.config !== config) console.log(`  [${(config = line.config)}]`);
    console.log(`    ${line.name.padEnd(width)}  ${line.outcome}`);
  }
  console.log('');
});

// --- n8n as shipped: binary data on disk ---------------------------------------------

describe('filesystem (n8n as shipped)', () => {
  const C = 'filesystem';

  test('this is the n8n version under test, with no binary data setting', () => {
    assert.match(inContainer('n8n --version').out, new RegExp(`^${N8N_VERSION.replaceAll('.', '\\.')}$`, 'm'));
    assert.equal(inContainer('echo "[$N8N_DEFAULT_BINARY_DATA_MODE][$N8N_STORAGE_PATH][$N8N_RESTRICT_FILE_ACCESS_TO]"').out, '[][][]');
  });

  test('the 5-byte test from the thread makes a file, stored on disk under a generated name', async () => {
    const file = await converted('fixed-name', HELLO, Buffer.from('hello'));
    assert.deepEqual({ fileName: file.fileName, mimeType: file.mimeType, fileExtension: file.fileExtension, fileSize: file.fileSize }, { fileName: 'test.txt', mimeType: 'text/plain', fileExtension: 'txt', fileSize: '5 B' });
    assert.match(file.id, STORED);
    assert.equal(inContainer(`cat ${STORAGE}/${file.id.split(':')[1]}`).out, 'hello');
    note(C, '5 bytes, test.txt, text/plain', `file made, ${file.id.replace(/[0-9a-f-]{36}$/, '<uuid>')}`);
  });

  test('a file name with a slash, a leading slash, "..", an absolute path or 300 characters is only a label', async () => {
    const names = [
      ['audio/reply.mp3', { fileName: 'reply.mp3', directory: 'audio' }],
      ['/etc/passwd', { fileName: 'passwd', directory: '/etc' }],
      ['../../outside.wav', { fileName: 'outside.wav', directory: '../..' }],
      ['/home/node/.n8n/config', { fileName: 'config', directory: '/home/node/.n8n' }],
      ['C:\\audio\\reply.wav', { fileName: 'C:\\audio\\reply.wav', directory: null }],
      [`${'x'.repeat(300)}.wav`, { fileName: `${'x'.repeat(300)}.wav`, directory: null }],
    ];
    for (const [fileName, expected] of names) {
      const file = await converted('fixed-name', { audio: HELLO.audio, fileName }, Buffer.from('hello'));
      assert.deepEqual({ fileName: file.fileName, directory: file.directory }, expected, fileName);
      // Where the bytes went does not depend on the name.
      assert.match(file.id, STORED, fileName);
      note(C, `file name ${fileName.length > 40 ? '300 x + .wav' : fileName}`, `file made, name "${file.fileName.length > 40 ? '300 x + .wav' : file.fileName}"${file.directory ? `, directory "${file.directory}"` : ''}`);
    }
    assert.equal(inContainer('ls /home/node/outside.wav /home/outside.wav /outside.wav 2>/dev/null | wc -l').out, '0');
    assert.equal(inContainer('wc -c < /home/node/.n8n/config').out, '32', 'the n8n settings file was not written to');
  });

  test('a MIME type or extension that does not fit the bytes never fails the node', async () => {
    const samples = pcm();
    const cases = [
      ['PCM bytes, audio/mp3, reply.mp3', { audio: base64(samples), fileName: 'reply.mp3', mimeType: 'audio/mp3' }, samples, { mimeType: 'audio/mp3', fileExtension: 'mp3' }],
      ['WAV bytes, audio/mp3, reply.mp3', { audio: base64(wav(samples)), fileName: 'reply.mp3', mimeType: 'audio/mp3' }, wav(samples), { mimeType: 'audio/mp3', fileExtension: 'mp3' }],
      ['WAV bytes, reply.mp3, no MIME type', { audio: base64(wav(samples)), fileName: 'reply.mp3' }, wav(samples), { mimeType: 'audio/mpeg', fileExtension: 'mp3' }],
      ['WAV bytes, no name, no MIME type', { audio: base64(wav(samples)) }, wav(samples), { mimeType: 'audio/wav', fileExtension: 'wav', fileName: 'file.wav' }],
      ['PCM bytes, no name, no MIME type', { audio: base64(samples) }, samples, { mimeType: 'text/plain', fileExtension: null, fileName: 'file' }],
      ['PCM bytes, MIME type "not a type"', { audio: base64(samples), mimeType: 'not a type' }, samples, { mimeType: 'not a type', fileExtension: null }],
      ['PCM bytes, setup.exe, application/x-msdownload', { audio: base64(samples), fileName: 'setup.exe', mimeType: 'application/x-msdownload' }, samples, { mimeType: 'application/x-msdownload', fileExtension: 'exe' }],
    ];
    for (const [name, body, bytes, expected] of cases) {
      const file = await converted('fixed-name', body, bytes);
      for (const [key, value] of Object.entries(expected)) assert.equal(file[key], value, `${name}: ${key}`);
      note(C, name, `file made, ${file.fileName}, ${file.mimeType}`);
    }
  });

  test('headerless PCM, WAV, the Gemini answer shape: the content is never looked at', async () => {
    const samples = pcm();
    const answer = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: base64(samples) } }] } }] };
    const file = await converted('gemini-path', answer, samples);
    assert.match(file.id, STORED);
    note(C, `PCM in ${GEMINI_PATH}`, 'file made, bytes unchanged');
    // The same bytes with a WAV header, and bytes that are not audio at all.
    await converted('fixed-name', { audio: base64(wav(samples)) }, wav(samples));
    const noise = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 197 + 13) & 255));
    await converted('fixed-name', { audio: base64(noise) }, noise);
    note(C, 'WAV bytes, and 4096 bytes that are no audio', 'file made, bytes unchanged');
  });

  test('odd values in the field: only a missing field and a non-text value fail, each with its own message', async () => {
    const empty = await converted('fixed-name', { audio: '' }, Buffer.alloc(0));
    assert.equal(empty.fileSize, '0 B');
    note(C, 'field is an empty string', 'file made, 0 bytes');

    assert.equal((await failed('fixed-name', { other: 1 })).message, 'The value in "audio" is not set');
    note(C, 'field is not there', 'The value in "audio" is not set');

    for (const [value, received] of [
      [null, 'Received null'],
      [5, 'Received type number (5)'],
      [{ data: 'aGVsbG8=' }, 'Received an instance of Object'],
    ]) {
      const { message } = await failed('fixed-name', { audio: value });
      assert.equal(message, notText('audio', received));
      note(C, `field is ${JSON.stringify(value)}`, brief(message));
    }

    // A data: URI prefix is never refused.
    const prefixed = await converted('fixed-name', { audio: `data:audio/wav;base64,${HELLO.audio}` });
    const bytes = Buffer.from(prefixed.back, 'base64');
    if (REWRITTEN) {
      // The prefix is removed and its type becomes the MIME type.
      assert.ok(bytes.equals(Buffer.from('hello')));
      assert.equal(prefixed.mimeType, 'audio/wav');
      note(C, 'data:audio/wav;base64, in front of 5 bytes', 'file made, prefix removed, audio/wav');
    } else {
      // The letters of the prefix are decoded as base64 too: the file starts
      // with bytes that were never audio.
      assert.equal(bytes.length, 19);
      assert.ok(!bytes.subarray(-5).equals(Buffer.from('hello')));
      note(C, 'data:audio/wav;base64, in front of 5 bytes', 'file made, 19 wrong bytes, no error');
    }

    const tricky = Buffer.from([251, 255, 254, 62, 63, 0]);
    await converted('fixed-name', { audio: tricky.toString('base64url') }, tricky);
    note(C, 'base64url (- and _)', 'file made, bytes correct');
    await converted('fixed-name', { audio: base64(pcm()).replace(/(.{76})/g, '$1\r\n') }, pcm());
    note(C, 'base64 with line breaks', 'file made, bytes correct');

    const text = await converted('fixed-name', { audio: 'hello world!!' });
    assert.equal(text.fileSize, '7 B');
    note(C, 'text that is not base64', 'file made, 7 meaningless bytes, no error');
  });

  test('16 MiB of base64 input makes a 16 MiB file', async () => {
    const file = await converted('fixed-name', { make: { field: 'audio', bytes: 16 * MIB }, fileName: 'long.wav' });
    assert.equal(file.fileSize, '16.8 MB');
    assert.equal(file.backLength, 4 * Math.ceil((16 * MIB) / 3), 'read back in full');
    assert.equal(inContainer(`wc -c < ${STORAGE}/${file.id.split(':')[1]}`).out, String(16 * MIB));
    note(C, '16 MiB', 'file made');
  });

  test('an expression in "Base64 Input Field" that returns the base64: the base64 becomes part of the error text', async () => {
    const small = await failed('expression', { audio: HELLO.audio });
    assert.equal(small.message, 'The value in "aGVsbG8=" is not set');
    note(C, 'Base64 Input Field = {{ $json.audio }}', 'The value in "aGVsbG8=" is not set');

    // The same setting, with base64 that happens to contain the letters
    // e-p-e-r-m in a row: the message from the thread, word for word.
    const audio = carrying('ePeRm');
    assert.ok(Buffer.from(audio, 'base64').length === 36);
    const error = await failed('expression', { audio });
    assert.equal(error.message, EPERM);
    assert.deepEqual(error.messages, [`The value in "${audio}" is not set`], 'the first text is kept in the error');
    note(C, '{{ $json.audio }}, base64 contains "ePeRm"', EPERM);

    // Other codes of the same list, for the same reason.
    assert.equal((await failed('expression', { audio: carrying('EnoEnt') })).message, ENOENT);
    assert.equal((await failed('expression', { audio: carrying('eAccEs') })).message, EACCES);
    note(C, '{{ $json.audio }}, base64 contains "EnoEnt"', ENOENT);

    // With the field name as fixed text the very same base64 is just a file.
    await converted('fixed-name', { audio }, Buffer.from(audio, 'base64'));
    note(C, 'Base64 Input Field = audio, same base64', 'file made');
  });

  test('a field name that is not in the item and contains "eperm" gives the message from the thread', async () => {
    assert.equal((await failed('by-path', { fieldPath: 'audioData', audio: HELLO.audio })).message, 'The value in "audioData" is not set');
    const error = await failed('by-path', { fieldPath: 'voicePermalink', audio: HELLO.audio });
    assert.equal(error.message, EPERM);
    assert.deepEqual(error.messages, ['The value in "voicePermalink" is not set']);
    note(C, 'missing field "voicePermalink"', EPERM);
    // The same name, when the field is there, is fine.
    await converted('by-path', { fieldPath: 'voicePermalink', voicePermalink: HELLO.audio }, Buffer.from('hello'));
    note(C, 'existing field "voicePermalink"', 'file made');
    // An empty field name takes the whole item as the value.
    const { message } = await failed('by-path', { fieldPath: '', audio: HELLO.audio });
    assert.equal(message, notText('', 'Received an instance of Object'));
    note(C, 'field name empty', brief(message));
  });

  test('a binary data folder n8n may not write to: EACCES has its own message, a real EPERM gives the one from the thread', async () => {
    const folder = `${STORAGE}/workflows/eperm-fixed-name/executions`;
    try {
      // Owned by another user.
      assert.equal(inContainer(`chown root:root ${folder} && chmod 755 ${folder}`, { root: true }).status, 0);
      const denied = await failed('fixed-name', HELLO);
      assert.equal(denied.message, EACCES);
      assert.match(denied.messages[0], new RegExp(`^EACCES: permission denied, mkdir '${folder}/\\d+'$`));
      note(C, 'storage folder owned by root', EACCES);
      assert.equal(inContainer(`chown node:node ${folder}`, { root: true }).status, 0);

      // Own folder without the write bit.
      assert.equal(inContainer(`chmod 555 ${folder}`).status, 0);
      assert.equal((await failed('fixed-name', HELLO)).message, EACCES);
      note(C, 'storage folder without write permission', EACCES);
      assert.equal(inContainer(`chmod 755 ${folder}`).status, 0);

      // Immutable (chattr +i): the kernel answers EPERM, to any user.
      const locked = inContainer(`chattr +i ${folder}`, { root: true });
      assert.equal(locked.status, 0, locked.out);
      const error = await failed('fixed-name', HELLO);
      assert.equal(error.message, EPERM);
      assert.match(error.messages[0], new RegExp(`^EPERM: operation not permitted, mkdir '${folder}/\\d+'$`));
      note(C, 'storage folder immutable (chattr +i)', EPERM);

      // A Code node that puts the base64 into the item writes nothing to disk.
      const inItem = await converted('code-binary', HELLO, Buffer.from('hello'));
      assert.equal(inItem.id, null);
      note(C, 'same folder, binary set in a Code node', 'works, nothing is written');
    } finally {
      inContainer(`chattr -i ${folder}; chown node:node ${folder}; chmod 755 ${folder}`, { root: true });
    }
    await converted('fixed-name', HELLO, Buffer.from('hello'));
  });

  test('Code node: headerless PCM gets a WAV header that parses, a WAV passes through unchanged', async () => {
    const samples = pcm(24000);
    const made = await converted('wav', { audio: base64(samples), mimeType: 'audio/L16;codec=pcm;rate=24000' });
    assert.deepEqual({ fileName: made.fileName, mimeType: made.mimeType }, { fileName: 'speech.wav', mimeType: 'audio/wav' });
    const parsed = parseWav(Buffer.from(made.back, 'base64'));
    assert.deepEqual({ format: parsed.format, channels: parsed.channels, rate: parsed.rate, bits: parsed.bits }, { format: 1, channels: 1, rate: 24000, bits: 16 });
    assert.ok(parsed.samples.equals(samples), 'the samples are untouched');
    note(C, 'PCM 24 kHz -> Add WAV Header -> Convert to File', 'valid WAV: PCM, 1 channel, 24000 Hz, 16 bit');

    // The rate is read from the MIME type.
    const slow = parseWav(Buffer.from((await converted('wav', { audio: base64(pcm(16000)), mimeType: 'audio/L16;codec=pcm;rate=16000' })).back, 'base64'));
    assert.equal(slow.rate, 16000);
    assert.equal(slow.byteRate, 32000);

    // Already a WAV: byte for byte the same, no second header.
    await converted('wav', { audio: base64(wav(samples)), mimeType: 'audio/wav' }, wav(samples));
    note(C, 'WAV -> Add WAV Header -> Convert to File', 'unchanged');
  });

  test('speech request to Telegram Send Document, both against the stand-in: a valid speech.wav arrives', async () => {
    for (const [model, kind] of [
      ['lab-tts-pcm', 'headerless PCM'],
      ['lab-tts-wav', 'WAV'],
    ]) {
      const count = (await json(await fetch(`${STANDIN}/_lab/uploads`))).length;
      const result = await run('speech-to-telegram', { model, text: 'Your order is ready.', chatId: 4242 });
      assert.equal(result.status, 'success', result.error?.message);
      assert.equal(result.answer.ok, true);
      const uploads = await json(await fetch(`${STANDIN}/_lab/uploads`));
      assert.equal(uploads.length, count + 1);
      const upload = uploads.at(-1);
      assert.deepEqual({ chatId: upload.chatId, fileName: upload.fileName, contentType: upload.contentType, size: upload.size }, { chatId: '4242', fileName: 'speech.wav', contentType: 'audio/wav', size: 24044 });
      const parsed = parseWav(Buffer.from(upload.base64, 'base64'));
      assert.deepEqual({ format: parsed.format, channels: parsed.channels, rate: parsed.rate, bits: parsed.bits }, { format: 1, channels: 1, rate: 24000, bits: 16 });
      assert.ok(parsed.samples.equals(pcm(24000, 0.5)), 'the samples the stand-in generated');
      note(C, `speech answer is ${kind} -> Telegram Send Document`, 'speech.wav, audio/wav, 24044 bytes, header parses');
    }
  });
});

// --- the other storage modes -----------------------------------------------------------

describe('memory (N8N_DEFAULT_BINARY_DATA_MODE=default)', () => {
  const C = 'memory';
  before(() => configure('memory'));

  test('files are made and stay inside the item', async () => {
    const file = await converted('fixed-name', HELLO, Buffer.from('hello'));
    assert.equal(file.id, null);
    const big = await converted('fixed-name', { make: { field: 'audio', bytes: 16 * MIB } });
    assert.equal(big.fileSize, '16.8 MB');
    note(C, '5 bytes, and 16 MiB', 'file made, kept in the item');
  });

  test('the message from the thread appears with no file system involved', async () => {
    assert.equal((await failed('expression', { audio: carrying('ePeRm') })).message, EPERM);
    note(C, '{{ $json.audio }}, base64 contains "ePeRm"', EPERM);
  });
});

describe('database (N8N_DEFAULT_BINARY_DATA_MODE=database)', () => {
  const C = 'database';
  before(() => configure('database'));

  test('files are made and stored in the database', async () => {
    const file = await converted('fixed-name', HELLO, Buffer.from('hello'));
    assert.match(file.id, /^database:[0-9a-f-]{36}$/);
    const big = await converted('fixed-name', { make: { field: 'audio', bytes: 16 * MIB } });
    assert.match(big.id, /^database:/);
    note(C, '5 bytes, and 16 MiB', 'file made, id database:<uuid>');
  });

  test('the message from the thread appears here too', async () => {
    assert.equal((await failed('expression', { audio: carrying('ePeRm') })).message, EPERM);
    note(C, '{{ $json.audio }}, base64 contains "ePeRm"', EPERM);
  });
});

describe('readonly (binary data folder on a read-only mount)', () => {
  const C = 'readonly';
  before(() => configure('readonly'));

  test('the write fails, and not with the message from the thread', async () => {
    assert.match(inContainer('touch /lab-readonly/probe').out, /Read-only file system/);
    const error = await failed('fixed-name', HELLO);
    // Node's recursive mkdir reports a read-only file system as ENOENT.
    assert.equal(error.message, ENOENT);
    assert.deepEqual(error.messages, ["ENOENT: no such file or directory, mkdir '/lab-readonly/workflows'"]);
    note(C, '5 bytes, test.txt, text/plain', `${ENOENT} (ENOENT ... mkdir '/lab-readonly/workflows')`);
    await converted('code-binary', HELLO, Buffer.from('hello'));
    note(C, 'binary set in a Code node', 'works, nothing is written');
  });
});

describe('restricted (file access restrictions set, binary data folder on a 1 MB disk)', () => {
  const C = 'restricted';
  before(() => configure('restricted'));

  test('N8N_RESTRICT_FILE_ACCESS_TO and N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES do not apply to this node', async () => {
    assert.equal(inContainer('echo "[$N8N_RESTRICT_FILE_ACCESS_TO][$N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES][$N8N_STORAGE_PATH]"').out, '[/home/node/allowed][true][/lab-small]');
    const file = await converted('fixed-name', HELLO, Buffer.from('hello'));
    assert.match(file.id, STORED);
    assert.equal(inContainer(`cat /lab-small/${file.id.split(':')[1]}`).out, 'hello', 'written outside the allowed folder');
    // A name that points into the blocked n8n folder is still only a label.
    await converted('fixed-name', { audio: HELLO.audio, fileName: '/home/node/.n8n/config' }, Buffer.from('hello'));
    note(C, '5 bytes, also with file name /home/node/.n8n/config', 'file made');
  });

  test('a full disk fails with its own text', async () => {
    const error = await failed('fixed-name', { make: { field: 'audio', bytes: 2 * MIB } });
    assert.equal(error.message, 'ENOSPC: no space left on device, write');
    note(C, '2 MiB onto a 1 MB disk', 'ENOSPC: no space left on device, write');
    // The failed write leaves nothing behind: small files still fit.
    await converted('fixed-name', HELLO, Buffer.from('hello'));
  });
});
