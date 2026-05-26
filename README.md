# @absolutejs/meeting adapters

Platform **source adapters** for [`@absolutejs/meeting`](../meeting). Each is its
own published package under this directory (mirrors `voice-adapters/`). An adapter
implements the `MeetingSource` contract — join a call and stream its audio (and,
when available, the participant roster) into the meeting core, which runs the
[`@absolutejs/voice`](../voice) scribe for live diarized transcription.

```
meeting-adapters/
  recall/    -> @absolutejs/meeting-recall    (Recall.ai: Meet / Zoom / Teams)   [published, needs RECALL_API_KEY]
  discord/   -> @absolutejs/meeting-discord    (@discordjs/voice receive)          [published, needs a bot token]
```

A `MeetingSource` is intentionally small:

```ts
type MeetingSource = {
  readonly format: AudioFormat;              // audio it emits (fed to the scribe's STT)
  on(event, handler): () => void;            // "audio" | "participant" | "end" | "error"
  start(): Promise<void>;                    // join the call
  stop(reason?): Promise<void>;              // leave
};
```

See `@absolutejs/meeting`'s `createBufferMeetingSource` for the reference
implementation.

## Status

- **recall** — built. One integration covers Google Meet / Zoom / Teams. Recall
  joins as a bot and streams per-participant raw PCM (mono 16-bit LE @ 16 kHz)
  to a websocket you host; the adapter decodes it into diarized `audio` +
  `participant` events. Verified live against a Recall workspace (bot create /
  list / join lifecycle). See [`recall/README.md`](./recall/README.md).
- **discord** — built + published. Native `@discordjs/voice` receive (per-user
  Opus → mono PCM), so speakers are known without diarization. The bot joins a
  voice channel and streams each participant in. See
  [`discord/README.md`](./discord/README.md).
