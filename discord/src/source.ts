import { Readable, Transform } from "node:stream";
import type { AudioFormat } from "@absolutejs/voice";
import type {
  MeetingParticipant,
  MeetingSource,
  MeetingSourceEventMap,
  SpeakAudio,
} from "@absolutejs/meeting";
import { Client, GatewayIntentBits } from "discord.js";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
// Import prism's Opus decoder via its subpath, NOT the package index. The index
// pulls in prism's FFmpeg module, which does a literal `require('ffmpeg-static')`
// — an optional dep we never use that breaks bundlers / `bun --compile`. The opus
// subpath needs no ffmpeg. (The subpath is declared `any` in prism-opus.d.ts.)
import prismOpus from "prism-media/src/opus/Opus";

const OpusDecoder = (
  prismOpus as unknown as {
    Decoder: new (options: {
      channels: number;
      frameSize: number;
      rate: number;
    }) => NodeJS.ReadWriteStream;
  }
).Decoder;

/**
 * Discord delivers per-user Opus at 48 kHz stereo; we decode + downmix to mono
 * PCM s16le. Because Discord gives one stream PER USER, speakers are known
 * exactly — no diarization needed (each `audio` event carries the Discord user id).
 */
export const DISCORD_AUDIO_FORMAT: AudioFormat = {
  channels: 1,
  container: "raw",
  encoding: "pcm_s16le",
  sampleRateHz: 48000,
};

export type DiscordMeetingSourceOptions = {
  /** Bot token. The app needs the Guilds + GuildVoiceStates intents and
   *  Connect permission in the target channel. Required unless `client` is given. */
  token?: string;
  /** Guild (server) id. */
  guildId: string;
  /** Voice channel id to join + listen in. */
  channelId: string;
  /** A pre-built, logged-in client to reuse instead of creating one from `token`. */
  client?: Client;
  /** Ready-state timeout (ms) when joining the channel. Default 30000. */
  readyTimeoutMs?: number;
  /** Leave (emit `end`) when no human remains in the channel for this long.
   *  Default 30000. Set to 0 to disable and stay until explicitly stopped. */
  leaveWhenAloneMs?: number;
};

/** Downmix interleaved 16-bit LE stereo PCM to mono (average L+R). */
export const stereoToMono = (stereo: Buffer): Uint8Array => {
  const frames = Math.floor(stereo.length / 4); // 2 channels * 2 bytes
  const mono = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const left = stereo.readInt16LE(i * 4);
    const right = stereo.readInt16LE(i * 4 + 2);
    mono[i] = (left + right) >> 1;
  }

  return new Uint8Array(mono.buffer, mono.byteOffset, mono.byteLength);
};

/** Upmix mono 16-bit LE PCM to stereo by duplicating each sample (L=R=s). */
export const monoToStereo = (mono: Buffer): Buffer => {
  const frames = Math.floor(mono.length / 2);
  const stereo = Buffer.allocUnsafe(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const sample = mono.readInt16LE(i * 2);
    stereo.writeInt16LE(sample, i * 4);
    stereo.writeInt16LE(sample, i * 4 + 2);
  }

  return stereo;
};

const toBuffer = (data: ArrayBuffer | Uint8Array): Buffer =>
  data instanceof ArrayBuffer
    ? Buffer.from(data)
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

// Discord emits a 3-byte Opus "silence frame" (0xF8 0xFF 0xFE) at the start/end
// of speech bursts. Feeding silence/degenerate frames to the opusscript WASM
// decoder can trip a fatal internal CELT assertion (opus_decoder.c:492,
// CELT_SET_END_BAND) that calls emscripten abort() — which poisons the WASM
// instance for the WHOLE process, so every subsequent decode (all users, all
// calls) fails and the bot captures no audio. Dropping these frames before the
// decoder avoids the abort. End-of-speech detection is handled by the receiver's
// EndBehavior upstream, so dropping silence here doesn't affect it.
const isOpusSilenceFrame = (buf: Buffer): boolean =>
  buf.length <= 3 && buf[0] === 0xf8 && buf[1] === 0xff && buf[2] === 0xfe;

const opusSilenceFilter = (): Transform =>
  new Transform({
    transform(chunk, _encoding, callback) {
      const buf = chunk as Buffer;
      if (buf.length === 0 || isOpusSilenceFrame(buf)) {
        callback();

        return;
      }
      callback(null, buf);
    },
  });

/**
 * A `MeetingSource` backed by a Discord voice channel. The bot joins the
 * channel and, for each speaking user, decodes their Opus stream to mono PCM and
 * emits it as `audio` tagged with the Discord user id (so the meeting core
 * labels turns by real speaker without diarization).
 */
export const createDiscordMeetingSource = (
  options: DiscordMeetingSourceOptions,
): MeetingSource => {
  const listeners: {
    [K in keyof MeetingSourceEventMap]: Set<
      (payload: MeetingSourceEventMap[K]) => void | Promise<void>
    >;
  } = {
    audio: new Set(),
    end: new Set(),
    error: new Set(),
    participant: new Set(),
  };
  const emit = <K extends keyof MeetingSourceEventMap>(
    event: K,
    payload: MeetingSourceEventMap[K],
  ) => {
    for (const handler of listeners[event]) void handler(payload);
  };

  const seen = new Set<string>();
  let client: Client | null = null;
  let connection: VoiceConnection | null = null;
  let ownsClient = false;
  let ended = false;
  let emptyTimer: ReturnType<typeof setTimeout> | null = null;
  let voiceStateHandler: (() => void) | null = null;
  const leaveWhenAloneMs = options.leaveWhenAloneMs ?? 30000;

  // `end` can be reached several ways (empty channel, disconnect, explicit
  // stop, and the meeting core calling stop() in response to our own end) —
  // emit it at most once so the meeting finalizes a single time.
  const emitEndOnce = (reason: string) => {
    if (ended) return;
    ended = true;
    emit("end", { reason });
  };

  // Count non-bot members currently in the target voice channel.
  const humansInChannel = (): number => {
    const channel = client?.channels.cache.get(options.channelId);
    if (!channel || !channel.isVoiceBased()) return 0;

    return channel.members.filter((m) => !m.user.bot).size;
  };

  // When the last human leaves, start a grace timer; if still empty when it
  // fires, leave. Any human (re)joining cancels a pending leave.
  const reconcileOccupancy = () => {
    if (leaveWhenAloneMs <= 0 || ended) return;
    if (humansInChannel() > 0) {
      if (emptyTimer) {
        clearTimeout(emptyTimer);
        emptyTimer = null;
      }

      return;
    }
    if (emptyTimer) return;
    emptyTimer = setTimeout(() => {
      emptyTimer = null;
      if (humansInChannel() === 0) emitEndOnce("empty-channel");
    }, leaveWhenAloneMs);
  };

  const announce = async (userId: string) => {
    if (seen.has(userId)) return;
    seen.add(userId);
    let name: string | undefined;
    try {
      const user = await client?.users.fetch(userId);
      name = user?.globalName ?? user?.username;
    } catch {
      // roster name is best-effort
    }
    const participant: MeetingParticipant = {
      id: userId,
      platform: "discord",
      ...(name ? { name } : {}),
    };
    emit("participant", { participant });
  };

  const onSpeakingStart = (userId: string) => {
    if (!connection) return;
    void announce(userId);
    const opus = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new OpusDecoder({
      channels: 2,
      frameSize: 960,
      rate: 48000,
    });
    const filter = opusSilenceFilter();
    opus.on("error", (error: Error) => emit("error", { error }));
    filter.on("error", (error: Error) => emit("error", { error }));
    decoder.on("error", (error: Error) => emit("error", { error }));
    decoder.on("data", (pcm: Buffer) =>
      emit("audio", { chunk: stereoToMono(pcm), participant: userId }),
    );
    opus.pipe(filter).pipe(decoder);
  };

  return {
    format: DISCORD_AUDIO_FORMAT,
    on: (event, handler) => {
      listeners[event].add(handler as never);

      return () => {
        listeners[event].delete(handler as never);
      };
    },
    start: async () => {
      if (!options.client && !options.token) {
        throw new Error("token or client is required");
      }
      client =
        options.client ??
        new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildVoiceStates,
          ],
        });
      if (!options.client) {
        ownsClient = true;
        await client.login(options.token as string);
      }

      const channel = await client.channels.fetch(options.channelId);
      if (!channel || !channel.isVoiceBased()) {
        throw new Error("channelId is not a voice channel");
      }

      connection = joinVoiceChannel({
        adapterCreator: channel.guild.voiceAdapterCreator,
        channelId: options.channelId,
        debug: true,
        guildId: options.guildId,
        selfDeaf: false, // must hear to receive
        selfMute: true, // the referee only listens
      });
      // Diagnostic plumbing — voice handshakes are the most common failure
      // mode (close-code 4017 'DAVE required', UDP egress blocks, etc.) and
      // without these you only see the eventual entersState(Ready) timeout
      // with no clue where it stalled. Logged at info; cheap enough to leave
      // on in prod, and the only way to debug a compile-mode regression that
      // doesn't repro in dev.
      connection.on("stateChange", (oldS, newS) => {
        console.info(
          "[meeting-discord] state " + oldS?.status + " -> " + newS?.status +
            ((newS as { closeCode?: number }).closeCode !== undefined
              ? " closeCode=" + (newS as { closeCode?: number }).closeCode
              : "") +
            ((newS as { reason?: unknown }).reason !== undefined
              ? " reason=" + JSON.stringify((newS as { reason?: unknown }).reason)
              : ""),
        );
      });
      connection.on("error", (error) =>
        console.error(
          "[meeting-discord] connection error: " +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
      connection.on("debug", (m) => console.info("[meeting-discord] " + m));
      await entersState(
        connection,
        VoiceConnectionStatus.Ready,
        options.readyTimeoutMs ?? 30000,
      );

      connection.receiver.speaking.on("start", onSpeakingStart);
      connection.on(VoiceConnectionStatus.Disconnected, () =>
        emitEndOnce("disconnected"),
      );

      // Auto-leave when the channel empties out (e.g. everyone hangs up but the
      // bot keeps sitting there). Recompute occupancy on every voice-state
      // change in the guild, and once now in case it's already just the bot.
      if (leaveWhenAloneMs > 0) {
        voiceStateHandler = () => reconcileOccupancy();
        client.on("voiceStateUpdate", voiceStateHandler);
        reconcileOccupancy();
      }
    },
    speak: async (audio: SpeakAudio) => {
      if (!connection) {
        throw new Error("discord speak: not connected to a voice channel");
      }
      if (audio.format !== "pcm") {
        throw new Error(
          `discord speak: unsupported format "${audio.format}" — supply 48 kHz s16le PCM`,
        );
      }
      if (audio.sampleRateHz !== 48000) {
        throw new Error(
          `discord speak: sample rate must be 48000 Hz (got ${audio.sampleRateHz})`,
        );
      }
      const pcm = toBuffer(audio.data);
      const stereo =
        audio.channels === 2
          ? pcm
          : audio.channels === 1
            ? monoToStereo(pcm)
            : (() => {
                throw new Error(
                  `discord speak: only 1 or 2 channels supported (got ${audio.channels})`,
                );
              })();

      // StreamType.Raw expects 48 kHz stereo s16le — Discord opus-encodes
      // internally. Subscribe a fresh player so concurrent speak() calls don't
      // chop each other off mid-utterance (one player == one playback queue).
      const resource = createAudioResource(Readable.from(stereo), {
        inputType: StreamType.Raw,
      });
      const player = createAudioPlayer();
      const subscription = connection.subscribe(player);
      player.play(resource);

      try {
        await new Promise<void>((resolve, reject) => {
          player.once(AudioPlayerStatus.Idle, () => resolve());
          player.once("error", (error) =>
            reject(error instanceof Error ? error : new Error(String(error))),
          );
        });
      } finally {
        try {
          player.stop(true);
        } catch {
          // already idle
        }
        subscription?.unsubscribe();
      }
    },
    stop: async (reason) => {
      if (emptyTimer) {
        clearTimeout(emptyTimer);
        emptyTimer = null;
      }
      if (client && voiceStateHandler) {
        client.off("voiceStateUpdate", voiceStateHandler);
        voiceStateHandler = null;
      }
      try {
        connection?.destroy();
      } catch {
        // already torn down
      }
      connection = null;
      if (ownsClient && client) {
        try {
          await client.destroy();
        } catch {
          // ignore
        }
      }
      emitEndOnce(reason ?? "stopped");
    },
  };
};
