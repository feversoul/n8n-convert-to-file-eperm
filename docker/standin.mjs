// Stand-in for the two outside services of the speech-to-telegram workflow.
// Nothing is forwarded anywhere: Gemini and Telegram are never contacted.
//
//   POST /v1beta/models/<model>:generateContent
//        The answer has the shape of Gemini's generateContent with audio
//        output: candidates[0].content.parts[0].inlineData { mimeType, data }.
//        The audio is half a second of a 440 Hz tone, 24 kHz mono 16-bit.
//          model "lab-tts-pcm"  headerless PCM, "audio/L16;codec=pcm;rate=24000"
//          model "lab-tts-wav"  the same samples as a complete WAV, "audio/wav"
//   POST /bot<token>/sendDocument
//        multipart/form-data with chat_id and document, as the Telegram Bot
//        API takes it. Answers { ok: true, result: Message } and keeps the
//        upload.
//   GET  /_lab/uploads   what arrived at sendDocument (file bytes as base64)
//   GET  /health

import { createServer } from 'node:http';

const RATE = 24000;

function tone() {
  const samples = RATE / 2;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / RATE)), i * 2);
  return pcm;
}

function wavOf(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const uploads = [];

const read = (request) =>
  new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });

const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

// The parts of a multipart/form-data body: [{ name, filename, type, bytes }].
function multipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? '');
  if (!boundary) return [];
  const mark = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts = [];
  let at = body.indexOf(mark);
  while (at !== -1) {
    const next = body.indexOf(mark, at + mark.length);
    if (next === -1) break;
    const part = body.subarray(at + mark.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1) {
      const head = part.subarray(0, split).toString('utf8');
      parts.push({
        name: /name="([^"]*)"/.exec(head)?.[1],
        filename: /filename="([^"]*)"/.exec(head)?.[1],
        type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1],
        bytes: part.subarray(split + 4),
      });
    }
    at = next;
  }
  return parts;
}

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://standin');
  if (url.pathname === '/health') return send(response, 200, { ok: true });
  if (url.pathname === '/_lab/uploads') return send(response, 200, uploads);

  const speech = /^\/v1beta\/models\/([^/:]+):generateContent$/.exec(url.pathname);
  if (request.method === 'POST' && speech) {
    await read(request);
    const pcm = tone();
    const inlineData = speech[1] === 'lab-tts-wav' ? { mimeType: 'audio/wav', data: wavOf(pcm).toString('base64') } : { mimeType: `audio/L16;codec=pcm;rate=${RATE}`, data: pcm.toString('base64') };
    return send(response, 200, { candidates: [{ content: { parts: [{ inlineData }], role: 'model' }, finishReason: 'STOP', index: 0 }], modelVersion: speech[1] });
  }

  if (request.method === 'POST' && /^\/bot[^/]+\/sendDocument$/.test(url.pathname)) {
    const parts = multipart(await read(request), request.headers['content-type']);
    const chat = parts.find((part) => part.name === 'chat_id')?.bytes.toString('utf8');
    const file = parts.find((part) => part.name === 'document');
    if (!chat) return send(response, 400, { ok: false, error_code: 400, description: 'Bad Request: chat_id is empty' });
    if (!file?.filename) return send(response, 400, { ok: false, error_code: 400, description: 'Bad Request: there is no document in the request' });
    uploads.push({ chatId: chat, fileName: file.filename, contentType: file.type ?? null, size: file.bytes.length, base64: file.bytes.toString('base64') });
    return send(response, 200, {
      ok: true,
      result: { message_id: uploads.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(chat), type: 'private' }, document: { file_name: file.filename, mime_type: file.type ?? 'application/octet-stream', file_id: `lab-${uploads.length}`, file_unique_id: `lab-u-${uploads.length}`, file_size: file.bytes.length } },
    });
  }

  send(response, 404, { ok: false, error_code: 404, description: 'Not Found' });
}).listen(8080, () => console.log('standin: listening on 8080'));
