// node scripts/build.mjs
// Writes workflows/*.json. Every case workflow is
//
//   Webhook -> Input -> Convert to File -> Read Back -> Result
//
//   Input            the JSON body of the request becomes the item
//   Convert to File  "Move Base64 String to File", version 1.1, the node from
//                    the thread. The cases differ in "Base64 Input Field".
//   Read Back        Extract from File, "Move File to Base64 String": reads
//                    the stored file again
//   Result           what the file is called, where it is stored, its bytes
//
// The webhook answers with the Result item. When Convert to File fails the
// webhook answers 500 and the error is in the execution.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');

// The path of the audio in a Gemini generateContent answer.
export const GEMINI_PATH = 'candidates[0].content.parts[0].inlineData.data';
export const TELEGRAM = { telegramApi: { id: 'epermLabTelegram', name: 'Lab Telegram (stand-in)' } };

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const webhook = (path) => ({
  name: 'Webhook',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  webhookId: `eperm-${path}`,
  parameters: { httpMethod: 'POST', path: `eperm/${path}`, responseMode: 'lastNode', responseData: 'firstEntryJson', options: {} },
});

const input = () => ({
  name: 'Input',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  parameters: {
    jsCode: [
      'const body = $input.first().json.body ?? {};',
      '// { "make": { "field": "audio", "bytes": 16777216 } } builds the base64 here,',
      '// for payloads larger than a webhook body may be.',
      'if (body.make) {',
      '  const bytes = Buffer.alloc(body.make.bytes);',
      '  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 255;',
      "  body[body.make.field] = bytes.toString('base64');",
      '}',
      'return [{ json: body }];',
    ].join('\n'),
  },
});

const convert = (sourceProperty, options = { fileName: '={{ $json.fileName }}', mimeType: '={{ $json.mimeType }}' }) => ({
  name: 'Convert to File',
  type: 'n8n-nodes-base.convertToFile',
  typeVersion: 1.1,
  parameters: { operation: 'toBinary', sourceProperty, binaryPropertyName: 'data', options },
});

const readBack = () => ({
  name: 'Read Back',
  type: 'n8n-nodes-base.extractFromFile',
  typeVersion: 1,
  parameters: { operation: 'binaryToPropery', binaryPropertyName: 'data', destinationKey: 'back', options: {} },
});

const result = (source = 'Convert to File') => ({
  name: 'Result',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  parameters: {
    jsCode: [
      `const file = $('${source}').first().binary.data;`,
      'const back = $input.first().json.back;',
      'return [{ json: {',
      '  fileName: file.fileName ?? null,',
      '  directory: file.directory ?? null,',
      '  fileExtension: file.fileExtension ?? null,',
      '  mimeType: file.mimeType ?? null,',
      '  fileSize: file.fileSize ?? null,',
      "  // 'filesystem-v2:workflows/...' when stored, null when the bytes travel in the item",
      '  id: file.id ?? null,',
      '  backLength: back.length,',
      '  // The stored bytes, base64. Left out when large.',
      '  back: back.length <= 400000 ? back : null,',
      '  backHead: back.slice(0, 60),',
      '} }];',
    ].join('\n'),
  },
});

// Adds a 44-byte WAV header when the bytes are headerless PCM. Bytes that
// already start with RIFF....WAVE pass through unchanged.
export const WAV_CODE = [
  '// Where the base64 audio is. Gemini generateContent puts it in',
  '// candidates[0].content.parts[0].inlineData; change this line for another shape.',
  'const part = $json.candidates?.[0]?.content?.parts?.[0]?.inlineData ?? { data: $json.audio, mimeType: $json.mimeType };',
  '',
  "const bytes = Buffer.from(part.data, 'base64');",
  "const isWav = bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE';",
  '',
  '// Gemini speech is 16-bit little-endian mono; the rate is in the MIME type',
  '// ("audio/L16;codec=pcm;rate=24000"), 24000 when it is not.',
  "const rate = Number(/rate=(\\d+)/.exec(part.mimeType ?? '')?.[1] ?? 24000);",
  'const channels = 1;',
  'const bits = 16;',
  '',
  'let wav = bytes;',
  'if (!isWav) {',
  '  const header = Buffer.alloc(44);',
  "  header.write('RIFF', 0, 'latin1');",
  '  header.writeUInt32LE(36 + bytes.length, 4);',
  "  header.write('WAVEfmt ', 8, 'latin1');",
  '  header.writeUInt32LE(16, 16); // size of the fmt chunk',
  '  header.writeUInt16LE(1, 20); // 1 = PCM',
  '  header.writeUInt16LE(channels, 22);',
  '  header.writeUInt32LE(rate, 24);',
  '  header.writeUInt32LE((rate * channels * bits) / 8, 28); // bytes per second',
  '  header.writeUInt16LE((channels * bits) / 8, 32); // bytes per sample frame',
  '  header.writeUInt16LE(bits, 34);',
  "  header.write('data', 36, 'latin1');",
  '  header.writeUInt32LE(bytes.length, 40);',
  '  wav = Buffer.concat([header, bytes]);',
  '}',
  '',
  "return { json: { wav: wav.toString('base64'), headerAdded: !isWav, sampleRate: isWav ? null : rate } };",
].join('\n');

const addWav = () => ({
  name: 'Add WAV Header',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  parameters: { mode: 'runOnceForEachItem', jsCode: WAV_CODE },
});

const WAV_OPTIONS = { fileName: 'speech.wav', mimeType: 'audio/wav' };

function workflow(name, title, nodes, extra = {}) {
  const placed = nodes.map((node, index) => ({ id: uid(), position: [index * 220, 0], ...node }));
  const connections = {};
  for (let i = 0; i < placed.length - 1; i++) connections[placed[i].name] = { main: [[{ node: placed[i + 1].name, type: 'main', index: 0 }]] };
  return { id: `eperm-${name}`, name: `Convert to File lab: ${title}`, nodes: placed, connections, settings: { executionOrder: 'v1' }, ...extra };
}

const cases = [
  // The setting the node asks for: the name of the field, as fixed text.
  workflow('fixed-name', 'field name as fixed text', [webhook('fixed-name'), input(), convert('audio'), readBack(), result()]),
  // The same with the path of a Gemini generateContent answer.
  workflow('gemini-path', 'Gemini field path as fixed text', [webhook('gemini-path'), input(), convert(GEMINI_PATH), readBack(), result()]),
  // The mistake: an expression that returns the base64 itself.
  workflow('expression', 'expression that returns the base64', [webhook('expression'), input(), convert('={{ $json.audio }}'), readBack(), result()]),
  // The field name comes from the request, to try names that are not there.
  workflow('by-path', 'field name from the request', [webhook('by-path'), input(), convert('={{ $json.fieldPath }}'), readBack(), result()]),
  // No Convert to File: a Code node puts the base64 into the item's binary.
  workflow('code-binary', 'binary set in a Code node', [
    webhook('code-binary'),
    input(),
    {
      name: 'Set Binary',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        mode: 'runOnceForEachItem',
        jsCode: "return { json: {}, binary: { data: { data: $json.audio, mimeType: $json.mimeType ?? 'application/octet-stream', fileName: $json.fileName ?? 'file' } } };",
      },
    },
    readBack(),
    result('Set Binary'),
  ]),
  // Headerless PCM -> WAV in a Code node, then Convert to File.
  workflow('wav', 'add a WAV header, then convert', [webhook('wav'), input(), addWav(), convert('wav', WAV_OPTIONS), readBack(), result()]),
  // Speech request (stand-in) -> WAV -> file -> Telegram Send Document (stand-in).
  workflow('speech-to-telegram', 'speech to Telegram as a WAV document', [
    webhook('speech-to-telegram'),
    {
      name: 'Generate Speech',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      parameters: {
        method: 'POST',
        url: "={{ 'http://standin:8080/v1beta/models/' + $json.body.model + ':generateContent' }}",
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          '={{ JSON.stringify({ contents: [{ parts: [{ text: $json.body.text }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } } }) }}',
        options: {},
      },
    },
    addWav(),
    convert('wav', WAV_OPTIONS),
    {
      name: 'Send Document',
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      credentials: TELEGRAM,
      parameters: { resource: 'message', operation: 'sendDocument', chatId: "={{ $('Webhook').first().json.body.chatId }}", binaryData: true, binaryPropertyName: 'data', additionalFields: {} },
    },
  ]),
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of cases) writeFileSync(join(out, `${item.id.replace('eperm-', '')}.json`), `${JSON.stringify(item, null, 2)}\n`);
console.log(`${readdirSync(out).length} workflows written to workflows/`);
