# @absolutejs/meeting-discord

The hosted AbsoluteJS.ai platform uses `createDiscordMeetingSourceFactory` to
bind the bot and guild configuration once. Each governed Meeting session
supplies its voice channel id dynamically, so installation never logs in or
joins a channel.

Discord voice source adapter for
[`@absolutejs/meeting`](https://github.com/absolutejs/meeting). A bot joins a
Discord **voice channel** and streams each participant's audio into the meeting
core, so the [`@absolutejs/voice`](https://github.com/absolutejs/voice) scribe
can transcribe the conversation live.

Discord gives one audio stream **per user**, so speakers are known exactly —
each transcript turn is labelled with the real Discord user, **no diarization
needed**.

## How it works

`@discordjs/voice` exposes a per-user Opus stream for everyone speaking. This
adapter subscribes to each, decodes Opus → PCM (48 kHz stereo) and downmixes to
mono `pcm_s16le`, and emits it as `audio` tagged with the Discord user id.

```
Discord voice channel ──(per-user Opus)──▶ adapter (decode + downmix) ──▶ @absolutejs/meeting ──▶ scribe ──▶ per-speaker turns
```

## Install

```sh
bun add @absolutejs/meeting-discord @absolutejs/meeting @absolutejs/voice discord.js @discordjs/voice
# Discord voice also needs an Opus codec + an encryption lib at runtime:
bun add @discordjs/opus libsodium-wrappers
# (or the pure-JS / native alternatives: opusscript, sodium-native, tweetnacl)
```

The bot application needs the **Guilds** + **Guild Voice States** gateway
intents and the **Connect** permission in the target channel.

## Usage

```ts
import { createMeeting } from "@absolutejs/meeting";
import { createDiscordMeetingSource } from "@absolutejs/meeting-discord";
import { deepgram } from "@absolutejs/voice-deepgram";

const source = createDiscordMeetingSource({
  token: process.env.DISCORD_BOT_TOKEN!,
  guildId: "123…", // server id
  channelId: "456…", // voice channel id
});

const meeting = await createMeeting({
  source,
  stt: deepgram({ apiKey: process.env.DEEPGRAM_API_KEY! }),
  sessionId: crypto.randomUUID(),
});
meeting.on("turn", (turn) => console.log(turn.participant?.name, turn.text));

await meeting.start(); // bot joins the channel + starts listening
// …
await meeting.stop(); // bot leaves
```

Pass a pre-built, logged-in `client` instead of `token` to share one Discord
client across features.

## API

- `createDiscordMeetingSource(options)` → `MeetingSource`.
  - `start()` logs in (if given a `token`), joins the voice channel, and
    subscribes to each speaker.
  - `stop()` leaves the channel + destroys the client it created.
- `DISCORD_AUDIO_FORMAT` — the mono 48 kHz `pcm_s16le` format it emits.
- `stereoToMono(buf)` — the downmix helper (exported for reuse/testing).

## License

Apache License 2.0. See [LICENSE](./LICENSE).
