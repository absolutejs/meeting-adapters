# @absolutejs/meeting adapters

Platform **source adapters** for [`@absolutejs/meeting`](../meeting). Each is its
own published package under this directory (mirrors `voice-adapters/`). An adapter
implements the `MeetingSource` contract — join a call and stream its audio (and,
when available, the participant roster) into the meeting core, which runs the
[`@absolutejs/voice`](../voice) scribe for live diarized transcription.

```
meeting-adapters/
  recall/    -> @absolutejs/meeting-recall    (Recall.ai: Meet / Zoom / Teams)   [planned, needs RECALL_API_KEY]
  discord/   -> @absolutejs/meeting-discord    (@discordjs/voice receive)          [planned, needs a bot token]
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

- **recall** — first target (Meet/Zoom/Teams in one integration). Awaiting a
  Recall.ai API key to implement + test the real-time audio stream.
- **discord** — after recall. Native `@discordjs/voice` receive (per-user Opus
  → PCM), so speakers are known without diarization.
