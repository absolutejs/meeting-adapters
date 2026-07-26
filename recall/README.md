# @absolutejs/meeting-recall

[Recall.ai](https://recall.ai) source adapter for
[`@absolutejs/meeting`](https://github.com/absolutejs/meeting). Recall joins a
**Google Meet / Zoom / Teams** call as a bot and streams per-participant audio;
this adapter turns that into the `MeetingSource` the meeting core consumes, so
the [`@absolutejs/voice`](https://github.com/absolutejs/voice) scribe can
transcribe the call live with speaker labels.

One Recall integration covers all three platforms — you only pass a meeting URL.

For dynamic applications, `createRecallMeetingSourceFactory` binds the Recall
credentials and websocket once; `@absolutejs/meeting` supplies each approved
meeting URL as the managed session target. Studio uses this factory contract,
so installing the package never creates a bot or joins a call.

## How it works

Recall's bot dials **out** to a websocket _you_ host and streams
`audio_separate_raw` events: one stream per participant, mono 16-bit
little-endian PCM at 16 kHz (exactly the scribe's input format). Your server
accepts that socket and forwards each frame to `source.ingest()`, which decodes
the PCM and emits diarized `audio` + `participant` events.

```
Recall bot ──(wss, per-participant PCM)──▶ your server ──source.ingest()──▶ @absolutejs/meeting ──▶ voice scribe ──▶ diarized turns
```

## Install

```sh
bun add @absolutejs/meeting-recall @absolutejs/meeting @absolutejs/voice
```

## Usage

```ts
import { createMeeting } from "@absolutejs/meeting";
import { createRecallMeetingSource } from "@absolutejs/meeting-recall";
import { createDeepgramStt } from "@absolutejs/voice-deepgram";

// 1. A source backed by a Recall bot. `websocketUrl` is a public wss:// URL
//    your server listens on (Recall connects out to it).
const source = createRecallMeetingSource({
  apiKey: process.env.RECALL_API_KEY!,
  baseUrl: process.env.RECALL_API_BASE_URL, // regional; defaults to us-west-2
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  websocketUrl: "wss://your-app.example.com/meeting/recall",
  botName: "Deal Referee",
});

// 2. Wire it into the meeting core + a scribe STT.
const meeting = createMeeting({
  source,
  stt: createDeepgramStt({ apiKey: process.env.DEEPGRAM_API_KEY! }),
  sessionId: crypto.randomUUID(),
});
meeting.on("turn", (turn) => console.log(turn.speaker, turn.text));

await meeting.start(); // creates the bot; it joins + starts streaming

// 3. In your websocket handler, pipe each frame into the source:
//    ws.on("message", (data) => source.ingest(data));

await meeting.stop(); // bot leaves the call
```

## Region

A Recall workspace lives in exactly **one** region and its key only works
against that region's host. Pass `region` (`"us-west-2"` | `"us-east-1"` |
`"eu-central-1"` | `"ap-northeast-1"`) or a full `baseUrl`
(`https://us-west-2.recall.ai/api/v1`). Defaults to `us-west-2`.

## API

- `createRecallMeetingSource(options)` → `MeetingSource & { botId, ingest }`.
  - `start()` creates the bot with a realtime websocket endpoint pointed at
    `websocketUrl`.
  - `ingest(frame)` decodes a realtime frame (JSON string, bytes, or object)
    into `audio` / `participant` events.
  - `stop()` makes the bot leave the call.
- `createRecallClient(options)` → a thin typed client:
  `createBot`, `getBot`, `listBots`, `leaveBot`, `deleteBot`.
- `RECALL_AUDIO_FORMAT` — the PCM format Recall emits.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
