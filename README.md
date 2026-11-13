# n8n Convert to File: where "Operation not permitted" comes from

[![test](https://github.com/feversoul/n8n-convert-to-file-eperm/actions/workflows/test.yml/badge.svg)](https://github.com/feversoul/n8n-convert-to-file-eperm/actions/workflows/test.yml)

In a [forum thread](https://community.n8n.io/t/324536) a Convert to File node set to "Move Base64 String to File" fails on n8n Cloud 2.43.7 with `Operation not permitted, make sure you have the right permissions`. The thread has several theories and no measurement. This repository runs every candidate cause as a real workflow on the `n8nio/n8n:2.43.7` image (and again on `2.47.7`) and records what the node does: the file it makes, or the exact error text.

n8n Cloud itself was not tested. What is shown is which conditions make this node, in this version, produce this message, and which do not.

| Asked in the thread                                                   | What you get                                                                                                                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Is this a Cloud binary storage limitation or a configuration issue?" | Both can produce the message, and they can be told apart. The original error text is kept inside the error. Two ways to the exact message were found; one is storage, the other is a node setting. |
| Is it the Base64 Input Field (expression instead of a name)?          | It can be. With an expression that returns the base64, the base64 lands in the error text, and base64 that contains the letters `eperm` turns the text into the message from the thread. Measured. |
| Is it the audio format (headerless PCM or WAV)?                       | No. The node never looks at the bytes. PCM, WAV and noise all become a file, with any file name or MIME type.                                                                                      |
| Is it the size, a `data:` prefix, the file name?                      | No. 16 MiB works. A `data:` prefix gives a broken file without an error on 2.43.7. A file name with slashes, `..` or an absolute path is only a label.                                             |
| How do I get the audio to Telegram?                                   | A Code node that adds a WAV header when the bytes are headerless PCM, then Convert to File, then Telegram "Send Document". Tested against a stand-in for Telegram, with the WAV header parsed.     |

## The short answer

The message is not written by Convert to File. It is n8n's replacement text for the Node.js error code `EPERM`. n8n replaces the text of a node error when the error's text **contains** one of a list of codes, compared without regard to case. So there are two ways to get it:

1. **The operating system refused a file operation with EPERM** while n8n stored the file. n8n 2.x stores binary data on disk unless told otherwise. Shown here with a storage folder made immutable. This is the "Cloud storage" theory, and only n8n can look at it.
2. **Some other error text happened to contain the letters `eperm`.** Shown here in two ways: a missing input field whose name contains them (`voicePermalink`), and an expression in "Base64 Input Field" that returns the base64 itself. In the second case the node looks for a field _named_ like the whole base64 string, does not find it, and reports `The value in "<the whole base64>" is not set`. If that base64 contains `e`, `p`, `e`, `r`, `m` in a row, in any mix of upper and lower case, the text is replaced by the message from the thread. No file system is involved: it happens the same way with binary data in memory or in the database.

How often the second one strikes depends on the audio. For bytes that look random, each position in the base64 has a 1 in 33.5 million chance (2 of 64 characters, five times), so about 2% for 10 seconds of 24 kHz 16-bit mono audio and about 11% for a minute. That is arithmetic, not a measurement on real speech. The other times the same mistake shows a very long `The value in "..." is not set`.

Everything else that was tried gives a file or a different message.

## Check it on your own instance

Works on n8n Cloud.

1. Open the failed execution, click the Convert to File node and expand **Error details**. n8n keeps the text it replaced; in the execution data it is `data.resultData.error.messages[0]`. (The editor has an "Error details" block with a "From Convert to File" part for these texts. The lab read the field through the API and did not click through the editor.)
   - It starts with `The value in "` : the node did not find the field. Look at "Base64 Input Field". It takes the **name** of the field as fixed text, for a Gemini `generateContent` answer `candidates[0].content.parts[0].inlineData.data`. No `{{ }}`.
   - It starts with `EPERM: operation not permitted,` followed by a call and a path (the lab saw `mkdir '/home/node/.n8n/storage/workflows/<workflow>/executions/<id>'`): the instance could not write the file. Go to step 3.
2. Run the 5-byte test from the thread: Edit Fields with `sample` = `aGVsbG8=`, then Convert to File with input field `sample`, file name `test.txt`, MIME type `text/plain`. On a healthy 2.43.7 this makes a 5-byte file `hello`.
3. If the 5-byte test fails with the same message and the kept text starts with `EPERM:`, nothing in the workflow can change it. Send n8n support the execution id and that text. Only they can see which storage mode the instance runs, the state of its storage folder, and what refused the call.

Until support answers, a Code node can put the base64 into the item without storing anything (the `code-binary` workflow here): `return { json: {}, binary: { data: { data: $json.audio, mimeType: 'audio/wav', fileName: 'speech.wav' } } };`. In the lab it worked while the storage folder refused every write. Whether it helps on a Cloud instance in that state was not tested.

## What was tested

`npm run test:e2e` starts n8n five times on one data volume, each time with another configuration, and runs the case workflows over their production webhooks. Each workflow is Webhook, a Code node that turns the request body into the item, Convert to File (version 1.1, "Move Base64 String to File"), Extract from File to read the stored bytes back, and a Code node that reports the file. A test asserts the bytes read back, or the error of the failed execution read from n8n's API.

| Run        | Result          |
| ---------- | --------------- |
| n8n 2.43.7 | 19 of 19 passed |
| n8n 2.47.7 | 19 of 19 passed |

Results on 2.43.7. "File made" means the node succeeded and the bytes read back are the decoded input.

| Condition                                                                                                                       | Result                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **n8n as shipped (binary data on disk)**                                                                                        |                                                                                                                                                   |
| 5 bytes, `test.txt`, `text/plain`                                                                                               | File made, stored as `storage/workflows/<workflow>/executions/<id>/binary_data/<uuid>`                                                            |
| File name `audio/reply.mp3`, `/etc/passwd`, `../../outside.wav`, `/home/node/.n8n/config`, `C:\audio\reply.wav`, 300 characters | File made. The name is a label; the path on disk is always the generated one                                                                      |
| PCM or WAV bytes labelled `audio/mp3` / `reply.mp3`, MIME type `not a type`, `setup.exe`                                        | File made, labelled as asked. Nothing is transcoded or checked                                                                                    |
| Headerless PCM, the same with a WAV header, 4096 bytes of noise                                                                 | File made, bytes unchanged                                                                                                                        |
| 16 MiB                                                                                                                          | File made                                                                                                                                         |
| Field is an empty string                                                                                                        | File made, 0 bytes                                                                                                                                |
| Field is not there                                                                                                              | `The value in "audio" is not set`                                                                                                                 |
| Field is `null`, a number, an object                                                                                            | `The first argument must be of type string or an instance of Buffer, ... Received null` (2.47.7: `The value in "audio" is not valid Base64 data`) |
| `data:audio/wav;base64,` in front                                                                                               | File made, **wrong bytes**, no error (2.47.7: prefix removed, bytes correct)                                                                      |
| base64url, base64 with line breaks                                                                                              | File made, bytes correct                                                                                                                          |
| Text that is not base64                                                                                                         | File made, meaningless bytes, no error                                                                                                            |
| Base64 Input Field `{{ $json.audio }}`                                                                                          | `The value in "aGVsbG8=" is not set`                                                                                                              |
| The same, base64 contains `ePeRm`                                                                                               | **`Operation not permitted, make sure you have the right permissions`**                                                                           |
| The same, base64 contains `EnoEnt` / `eAccEs`                                                                                   | `The file or directory does not exist` / `Forbidden by access permissions, ...`                                                                   |
| That base64 with the field name as fixed text                                                                                   | File made                                                                                                                                         |
| Missing field named `voicePermalink`                                                                                            | **`Operation not permitted, make sure you have the right permissions`**                                                                           |
| Storage folder owned by another user, or without the write bit                                                                  | `Forbidden by access permissions, make sure you have the right permissions` (EACCES)                                                              |
| Storage folder immutable (`chattr +i`)                                                                                          | **`Operation not permitted, make sure you have the right permissions`** (EPERM on `mkdir`)                                                        |
| Same folder, binary set in a Code node instead                                                                                  | Works, nothing is written                                                                                                                         |
| **Other configurations**                                                                                                        |                                                                                                                                                   |
| `N8N_DEFAULT_BINARY_DATA_MODE=default` (memory): 5 bytes, 16 MiB                                                                | File made, bytes stay in the item                                                                                                                 |
| `N8N_DEFAULT_BINARY_DATA_MODE=database`: 5 bytes, 16 MiB                                                                        | File made, id `database:<uuid>`                                                                                                                   |
| Memory and database: `{{ $json.audio }}`, base64 contains `ePeRm`                                                               | **`Operation not permitted, make sure you have the right permissions`**                                                                           |
| Storage folder on a read-only mount                                                                                             | `The file or directory does not exist` (Node's recursive `mkdir` reports ENOENT there)                                                            |
| `N8N_RESTRICT_FILE_ACCESS_TO` and `N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES` set                                                      | File made. They do not apply to this node                                                                                                         |
| Storage folder on a full disk                                                                                                   | `ENOSPC: no space left on device, write`                                                                                                          |

The binary data modes this version accepts are `default`, `filesystem`, `s3`, `azure` and `database`. With no setting it is `filesystem`, or `database` in queue mode. `s3` and `azure` need a licence and were not run.

## Why, in the code

The list and the replacement are in [`packages/workflow/src/errors/abstract/node.error.ts`](https://github.com/n8n-io/n8n/blob/n8n%402.43.7/packages/workflow/src/errors/abstract/node.error.ts). In the image it is `n8n-workflow/dist/cjs/errors/abstract/node.error.js`:

```js
const COMMON_ERRORS = {
    ...
    ENOENT: 'The file or directory does not exist',
    EACCES: 'Forbidden by access permissions, make sure you have the right permissions',
    EPERM: 'Operation not permitted, make sure you have the right permissions',
    ...
};
...
for (const [errorCode, errorDescriptiveMessage] of Object.entries(COMMON_ERRORS)) {
    if ((message || '').toUpperCase().includes(errorCode.toUpperCase())) {
        newMessage = errorDescriptiveMessage;
        messages.push(message);
        break;
    }
}
```

Convert to File wraps whatever went wrong in a `NodeOperationError`, which runs this over the text. A Node.js file error reads `EPERM: operation not permitted, mkdir '...'`, so it matches. So does any other text with those five letters. `EPERM` is the shortest code in the list, which makes it the likeliest accident.

The field lookup is in [`packages/nodes-base/utils/binary.ts`](https://github.com/n8n-io/n8n/blob/n8n%402.43.7/packages/nodes-base/utils/binary.ts#L87-L129), linked in the thread by Anshul_Namdev: `get(data, options.sourceKey)`, then `The value in "${options.sourceKey}" is not set`. The setting is put into the text as it is.

The write is `FsByteStore.write` in `@n8n/blob-storage`: make the folder `<storage>/workflows/<workflow id>/executions/<execution id>/binary_data`, write a temporary file, rename it to a generated id. The file name option is not part of any path. In `default` mode the base64 stays in the item and in `database` mode it goes into a table; neither touches that folder.

## Audio that Telegram can take

Gemini returns speech either as a complete WAV or as headerless 16-bit PCM, depending on the API and mode ([speech generation docs](https://ai.google.dev/gemini-api/docs/speech-generation)). Headerless PCM is not a file any player opens, whatever name or MIME type Convert to File is given.

`workflows/speech-to-telegram.json` is: HTTP Request, **Add WAV Header** (Code node), Convert to File (`wav`, `speech.wav`, `audio/wav`), Telegram **Send Document**. The Code node passes a WAV through unchanged and puts a 44-byte header in front of anything else, with the sample rate from the MIME type (`audio/L16;codec=pcm;rate=24000`) and 24000 when there is none. Its first line says where the base64 is; change it for another answer shape.

The tests parse the header of the file that arrived: PCM, 1 channel, 24000 Hz, 16 bit, sizes consistent, samples untouched.

Send Document, because the Telegram Bot API takes [any file type](https://core.telegram.org/bots/api#senddocument) there. `sendAudio` asks for MP3 or M4A and `sendVoice` for OGG/Opus, MP3 or M4A. Turning WAV into one of those needs an encoder, which n8n does not have built in.

## Add it to your n8n

1. Fix the cause first (see "Check it on your own instance").
2. For the WAV header: add a Code node before Convert to File, mode "Run Once for Each Item", and paste the code of the "Add WAV Header" node from `workflows/wav.json`. Adjust its first line to where your base64 is.
3. In Convert to File set "Base64 Input Field" to `wav` (fixed text), file name `speech.wav`, MIME type `audio/wav`.
4. In the Telegram node use "Send Document" with the binary field `data`.

Or import `workflows/speech-to-telegram.json`, point the HTTP Request node at your speech request and pick your Telegram credential.

## What was not tested, and other limits

- **n8n Cloud.** Which storage mode a Cloud instance runs, and what its platform answers when a write is refused, is not known from here. The lab shows that an EPERM from the operating system gives the message; it cannot show that Cloud produced one.
- **The author's workflow.** It was not posted. Which of the two ways applies to it is for the check above to say.
- **Gemini and Telegram.** Neither was contacted. The speech answer is a stand-in in the shape of `generateContent` (`candidates[0].content.parts[0].inlineData`), and Telegram is a stand-in for `sendDocument` that records the upload. Whether Telegram's apps play a WAV document in place was not tested.
- **The editor.** Error texts were read from the API, not from the screen.
- Other causes of EPERM than an immutable folder (a security profile, a network file system). They would reach the same line of code with the same text.
- The odds for real speech. The figure above is for random-looking bytes.
- Convert to File version 1.2 (in n8n 2.45.6 and later), which refuses bad base64 with its own message. The workflows here use 1.1, the newest in 2.43.7.
- Queue mode, S3 and Azure storage, files larger than 16 MiB, the Code node on Cloud.

## Run it yourself

```sh
git clone https://github.com/feversoul/n8n-convert-to-file-eperm
cd n8n-convert-to-file-eperm
npm run test:e2e
```

Needs Docker and Node 20 or newer. A run takes about a minute after the images are there. `N8N_IMAGE=n8nio/n8n:2.47.7` picks another version, `KEEP_STACK=1` leaves n8n up on http://localhost:55697. The immutable-folder case uses `chattr` through a privileged `docker exec`.

`docker compose up -d` starts the same workflows on http://localhost:5678 without the tests, for example:

```sh
curl -s -X POST localhost:5678/webhook/eperm/expression -H 'content-type: application/json' \
  -d '{"audio":"eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4ePeRmAAA"}'
```

Files:

- `scripts/build.mjs`: writes `workflows/*.json`.
- `workflows/`: `fixed-name`, `gemini-path`, `expression`, `by-path`, `code-binary`, `wav`, `speech-to-telegram`.
- `docker/standin.mjs`: the stand-in for the speech request and for Telegram.
- `test/configs/`: the five n8n configurations.
- `test/e2e.test.mjs`: the assertions.

## License

MIT.
