import type { AudioFormat } from "@absolutejs/voice";
import type {
  ChatMessage,
  MeetingCapabilities,
  MeetingParticipant,
  MeetingSource,
  MeetingSourceEventMap,
  SpeakAudio,
} from "@absolutejs/meeting";
import {
  createRecallClient,
  type RecallAutomaticAudioOutput,
  type RecallBot,
  type RecallClient,
  type RecallClientOptions,
  type RecallRecordingConfig,
} from "./client";

/**
 * 200 ms of silence as mp3 (~489 bytes, 652 b64 chars). Recall requires
 * `automatic_audio_output` at create time to enable the `output_audio`
 * endpoint, so when a caller just wants speak() (no greeting jingle), we hand
 * Recall this near-inaudible placeholder.
 */
const SILENT_MP3_B64 =
  "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//NwwAAAAAAAAAAAAEluZm8AAAAPAAAACgAAAbwAd3d3d3d3d3d3h4eHh4eHh4eHh5aWlpaWlpaWlpalpaWlpaWlpaWltLS0tLS0tLS0tMPDw8PDw8PDw8PS0tLS0tLS0tLS4eHh4eHh4eHh4fDw8PDw8PDw8PD/////////////AAAAAExhdmM2MC4zMQAAAAAAAAAAAAAAACQDBgAAAAAAAAG87PIqcgAAAAAAAAAAAAAAAAD/8xDEAAAAA0gAAAAATEFNRTMuMTAwVVVVVf/zEsQNAAADSAAAAABVVVVVVVVVVVVVVVVVVf/zEMQbAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxCgAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDENQAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMRCAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxE8AAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDEXAAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMRpAAADSAAAAABVVVVVVVVVVVVVVVVV//MSxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVV";

const encodeBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }

  return btoa(binary);
};

/** Recall's `audio_separate_raw` stream is mono 16-bit little-endian PCM @ 16 kHz. */
export const RECALL_AUDIO_FORMAT: AudioFormat = {
  channels: 1,
  container: "raw",
  encoding: "pcm_s16le",
  sampleRateHz: 16000,
};

export type RecallMeetingSourceOptions = {
  /** A pre-built Recall client. Provide this, or the inline client options. */
  client?: RecallClient;
  /** Meeting URL the bot joins (Google Meet / Zoom / Teams). */
  meetingUrl: string;
  /**
   * Public wss:// URL Recall connects out to and streams audio frames to. Your
   * server hosts this socket and forwards each message to `ingest()`.
   */
  websocketUrl: string;
  /** Bot display name shown in the call. Defaults to "Deal Referee". */
  botName?: string;
  /** Extra recording_config merged onto the realtime audio config. */
  recordingConfig?: RecallRecordingConfig;
  /**
   * Arm the bot for `speak()` (Recall calls this `automatic_audio_output` —
   * a one-time create-time toggle that lights up the `output_audio` endpoint).
   * Pass `true` for a near-inaudible silent placeholder, or your own initial
   * audio. Default: `false` (listen-only bot, `speak()` will reject).
   */
  enableSpeak?: boolean | RecallAutomaticAudioOutput;
  /**
   * Heartbeat + reconnect resilience for the realtime socket.
   *
   * Recall dials the realtime socket OUT to *your* server (`websocketUrl`), so
   * the adapter can't re-dial it itself — true reconnection is consumer-driven
   * (your ws server accepts Recall's next connection and keeps piping into the
   * same `ingest`). What the adapter owns is telling a *transient drop* apart
   * from a *real call end*: platforms (notably Google Meet) routinely drop the
   * socket WITHOUT a clean end event, which would otherwise finalize a healthy
   * call early. When you report a drop via `notifySocketClosed`, the adapter
   * polls the Recall bot status (the heartbeat) with bounded backoff and only
   * emits `end` once Recall confirms the bot actually left/ended. A resumed
   * frame or `notifySocketOpen` cancels the check.
   */
  reconnect?: {
    /** Max status polls after a drop before giving up and ending. Default 5. */
    maxRetries?: number;
    /** Base backoff between polls (ms); grows linearly per attempt. Default 2000. */
    backoffMs?: number;
  };
} & Partial<RecallClientOptions>;

export type RecallMeetingSource = MeetingSource & {
  /** The Recall bot id, available once `start()` resolves. */
  readonly botId: string | null;
  /**
   * Feed one realtime frame received on your websocket. Accepts the raw
   * websocket message — a JSON string, bytes, or an already-parsed object.
   * Audio frames are decoded + emitted as `audio`; new speakers as `participant`.
   */
  ingest: (
    raw: string | ArrayBuffer | ArrayBufferView | Record<string, unknown>,
  ) => void;
  /**
   * Tell the adapter your realtime ws just connected (your socket's `open`).
   * Cancels any in-flight drop-verification so a successful reconnect doesn't
   * get finalized.
   */
  notifySocketOpen: () => void;
  /**
   * Tell the adapter your realtime ws just dropped (your socket's `close`). The
   * adapter begins heartbeat verification (polling bot status); it does NOT end
   * the meeting for a transient drop — only once Recall confirms a real end, or
   * after the bounded retries are exhausted. Pass the ws close `code` for traces.
   */
  notifySocketClosed: (code?: number) => void;
};

// MPEG-1 Layer III bitrate table (index 1..14) — TTS engines emit CBR, so the
// first frame header's bitrate makes bytes→duration a solid estimate.
const MP3_BITRATES_KBPS = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MP3_HEADER_SCAN_BYTES = 4096;
const MP3_FALLBACK_KBPS = 128;

/** Estimate an mp3's playback duration from its size + first-frame bitrate.
 *  bits / kbps = milliseconds. */
export const estimateMp3DurationMs = (bytes: Uint8Array) => {
  let kbps = MP3_FALLBACK_KBPS;
  const scanEnd = Math.min(bytes.length - 2, MP3_HEADER_SCAN_BYTES);
  for (let i = 0; i < scanEnd; i += 1) {
    // Frame sync: 11 set bits.
    if (bytes[i] !== 0xff || ((bytes[i + 1] ?? 0) & 0xe0) !== 0xe0) continue;
    const index = ((bytes[i + 2] ?? 0) >> 4) & 0x0f;
    const parsed = MP3_BITRATES_KBPS[index];
    if (parsed && parsed > 0) {
      kbps = parsed;
      break;
    }
  }

  return (bytes.length * 8) / kbps;
};

const decodeBase64 = (b64: string): Uint8Array => {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  return bytes;
};

const toMessage = (
  raw: string | ArrayBuffer | ArrayBufferView | Record<string, unknown>,
): Record<string, unknown> => {
  if (typeof raw === "string")
    return JSON.parse(raw) as Record<string, unknown>;
  if (raw instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  }
  if (ArrayBuffer.isView(raw)) {
    return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  }

  return raw;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * A `MeetingSource` backed by a Recall.ai bot. `start()` creates the bot with a
 * realtime websocket endpoint pointed at `websocketUrl`; your server accepts
 * that socket and pipes every message into `ingest()`, which decodes the
 * per-participant PCM and emits it as `audio` for the scribe.
 */
export const createRecallMeetingSource = (
  options: RecallMeetingSourceOptions,
): RecallMeetingSource => {
  const client =
    options.client ??
    createRecallClient({
      apiKey: options.apiKey ?? "",
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      region: options.region,
    });

  const listeners: {
    [K in keyof MeetingSourceEventMap]: Set<
      (payload: MeetingSourceEventMap[K]) => void | Promise<void>
    >;
  } = {
    audio: new Set(),
    chat: new Set(),
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

  const seenParticipants = new Set<string>();
  let botId: string | null = null;
  let stopped = false;
  let ended = false;
  // Tracks whether the consumer's realtime socket is believed up. Frames arriving
  // (or notifySocketOpen) flip it true; notifySocketClosed flips it false and
  // arms heartbeat verification.
  let socketAlive = false;
  let verifyTimer: ReturnType<typeof setTimeout> | null = null;
  let verifyAttempts = 0;

  // Speak-queue state: sends serialize on this chain (Recall's output_audio
  // replaces in-flight audio), each waiting out its predecessor's estimated
  // playback. stopSpeaking() bumps the generation (queued sends no-op) and
  // releases the active wait so the queue drains instantly on barge-in.
  let speakChain: Promise<void> = Promise.resolve();
  let speakGeneration = 0;
  let releasePlaybackWait: (() => void) | null = null;

  const waitEstimatedPlayback = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        releasePlaybackWait = null;
        resolve();
      }, ms);
      releasePlaybackWait = () => {
        clearTimeout(timer);
        releasePlaybackWait = null;
        resolve();
      };
    });

  // `end` is reachable from several places (real end events, ws-drop heartbeat,
  // explicit stop) — emit it at most once so the meeting finalizes a single time.
  const emitEndOnce = (reason: string) => {
    if (ended) return;
    ended = true;
    if (verifyTimer) {
      clearTimeout(verifyTimer);
      verifyTimer = null;
    }
    emit("end", { reason });
  };

  const toRoster = (
    participant: Record<string, unknown>,
  ): MeetingParticipant => ({
    id: String(participant.id),
    metadata: participant,
    platform: "recall",
    ...(typeof participant.name === "string" ? { name: participant.name } : {}),
  });

  // Recall bot status_changes whose last code signals the call is genuinely over
  // (vs. a transient transport drop). Used by the heartbeat to decide whether a
  // socket close should finalize the meeting.
  const isEndedBot = (bot: RecallBot): boolean => {
    const changes = bot.status_changes ?? [];
    const last = changes[changes.length - 1];
    const code = last?.code ?? "";

    return /(done|fatal|call_ended|ended)/i.test(code);
  };

  const cancelVerify = () => {
    if (verifyTimer) {
      clearTimeout(verifyTimer);
      verifyTimer = null;
    }
    verifyAttempts = 0;
  };

  // Heartbeat after a socket drop: poll the bot status with bounded linear
  // backoff. Confirmed end → finalize; still in-call → keep waiting; retries
  // exhausted → finalize as unrecovered. A resumed frame / reconnect cancels it.
  const startDropVerify = (code?: number) => {
    if (stopped || ended || verifyTimer) return;
    const maxRetries = options.reconnect?.maxRetries ?? 5;
    const backoffMs = options.reconnect?.backoffMs ?? 2000;
    verifyAttempts = 0;
    const tick = async () => {
      verifyTimer = null;
      if (stopped || ended || socketAlive) return;
      verifyAttempts += 1;
      try {
        const bot = botId ? await client.getBot(botId) : null;
        if (bot && isEndedBot(bot)) {
          emitEndOnce(
            `socket-closed:call-ended${typeof code === "number" ? `:${code}` : ""}`,
          );

          return;
        }
      } catch (error) {
        emit("error", { error: error as Error });
      }
      if (stopped || ended || socketAlive) return;
      if (verifyAttempts >= maxRetries) {
        emitEndOnce(
          `socket-closed-unrecovered${typeof code === "number" ? `:${code}` : ""}`,
        );

        return;
      }
      verifyTimer = setTimeout(() => void tick(), backoffMs * verifyAttempts);
    };
    verifyTimer = setTimeout(() => void tick(), backoffMs);
  };

  // Any traffic on the socket means it's alive — flip state and cancel a pending
  // drop verification (a genuine reconnect/resume).
  const markSocketAlive = () => {
    socketAlive = true;
    cancelVerify();
  };

  const handleAudioFrame = (data: Record<string, unknown>) => {
    // Recall nests the payload as data.data.{buffer,timestamp} + data.participant.
    const inner = asRecord(data.data);
    const buffer =
      (inner.buffer as string | undefined) ??
      (inner.b64_data as string | undefined) ??
      (typeof inner.data === "string" ? (inner.data as string) : undefined);
    if (typeof buffer !== "string" || buffer.length === 0) return;

    const participant = asRecord(data.participant ?? inner.participant);
    const participantId =
      participant.id !== undefined ? String(participant.id) : undefined;

    if (participantId && !seenParticipants.has(participantId)) {
      seenParticipants.add(participantId);
      emit("participant", { participant: toRoster(participant) });
    }

    emit("audio", {
      chunk: decodeBase64(buffer),
      ...(participantId ? { participant: participantId } : {}),
    });
  };

  // participant_events.chat_message → a `chat` event. Recall nests the message
  // under data.data.{text,timestamp} with the sender in data.participant.
  const handleChatMessage = (data: Record<string, unknown>) => {
    const inner = asRecord(data.data);
    const text =
      typeof inner.text === "string"
        ? inner.text
        : typeof inner.message === "string"
          ? inner.message
          : undefined;
    if (typeof text !== "string" || text.length === 0) return;

    const participant = asRecord(data.participant ?? inner.participant);
    const hasParticipant = participant.id !== undefined;
    const timestamp =
      typeof inner.timestamp === "number"
        ? inner.timestamp
        : typeof data.timestamp === "number"
          ? data.timestamp
          : undefined;

    const message: ChatMessage = {
      kind: "message",
      text,
      ...(hasParticipant
        ? { author: toRoster(participant), authorId: String(participant.id) }
        : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    };
    emit("chat", { message });
  };

  // participant_events.join / .leave → a `participant` event carrying status so
  // the core can track the live roster (leave = someone hung up).
  const handleParticipantEvent = (
    data: Record<string, unknown>,
    status: "joined" | "left",
  ) => {
    const inner = asRecord(data.data);
    const participant = asRecord(data.participant ?? inner.participant);
    if (participant.id === undefined) return;
    if (status === "joined") {
      const id = String(participant.id);
      if (seenParticipants.has(id)) return;
      seenParticipants.add(id);
    }
    emit("participant", { participant: toRoster(participant), status });
  };

  const ingest: RecallMeetingSource["ingest"] = (raw) => {
    if (stopped || ended) return;
    let message: Record<string, unknown>;
    try {
      message = toMessage(raw);
    } catch (error) {
      emit("error", { error: error as Error });

      return;
    }

    // A parsed frame means the realtime socket is delivering — treat it as a
    // heartbeat so any pending drop-verification is cancelled.
    markSocketAlive();

    const event = typeof message.event === "string" ? message.event : "";
    const data = asRecord(message.data);

    if (event === "audio_separate_raw.data" || (!event && data.data)) {
      handleAudioFrame(data);

      return;
    }

    if (event === "participant_events.chat_message") {
      handleChatMessage(data);

      return;
    }

    if (event === "participant_events.join") {
      handleParticipantEvent(data, "joined");

      return;
    }

    if (event === "participant_events.leave") {
      handleParticipantEvent(data, "left");

      return;
    }

    if (
      event.endsWith(".done") ||
      event.endsWith("call_ended") ||
      event === "bot.done" ||
      event === "bot.fatal"
    ) {
      emitEndOnce(event);
    }
  };

  const capabilities: MeetingCapabilities = {
    canChat: true,
    canSpeak: Boolean(options.enableSpeak),
  };

  return {
    get botId() {
      return botId;
    },
    capabilities,
    format: RECALL_AUDIO_FORMAT,
    ingest,
    notifySocketClosed: (code) => {
      socketAlive = false;
      startDropVerify(code);
    },
    notifySocketOpen: () => {
      markSocketAlive();
    },
    on: (event, handler) => {
      listeners[event].add(handler as never);

      return () => {
        listeners[event].delete(handler as never);
      };
    },
    speak: async (audio: SpeakAudio) => {
      if (!botId) {
        throw new Error(
          "recall speak: bot has not joined yet (call start() first)",
        );
      }
      if (audio.format !== "mp3") {
        throw new Error(
          `recall speak: unsupported format "${audio.format}" — supply mp3`,
        );
      }
      if (!options.enableSpeak) {
        throw new Error(
          "recall speak: bot was not created with enableSpeak — Recall requires automatic_audio_output at create time to enable output_audio",
        );
      }
      const bytes =
        audio.data instanceof ArrayBuffer
          ? new Uint8Array(audio.data)
          : audio.data;
      // Recall's output_audio REPLACES any in-flight audio, so back-to-back
      // sends would cut each other off. Serialize: each speak() waits for the
      // previous one's ESTIMATED playback (size ÷ first-frame bitrate) before
      // sending, and resolves after its own — matching the Discord adapter's
      // await-real-playback contract so callers can sentence-stream safely.
      // stopSpeaking() cancels the pending waits (barge-in cuts the queue).
      const generation = speakGeneration;
      const send = async () => {
        if (generation !== speakGeneration) return;
        await client.outputAudioMp3(botId, encodeBase64(bytes));
        await waitEstimatedPlayback(estimateMp3DurationMs(bytes));
      };
      // Chain regardless of a predecessor's failure, but let each caller see
      // only its OWN error.
      const turn = speakChain.then(send, send);
      speakChain = turn.catch(() => undefined);
      await turn;
    },
    sendChat: async (text) => {
      if (!botId) {
        throw new Error(
          "recall sendChat: bot has not joined yet (call start() first)",
        );
      }
      await client.sendChatMessage(botId, text);
    },
    stopSpeaking: async () => {
      // Barge-in: cut the bot's in-progress audio so it doesn't talk over a
      // participant who started speaking. Also drops anything still queued in
      // the speak chain (bump the generation + release the playback wait).
      // No-op before the bot has joined.
      speakGeneration += 1;
      releasePlaybackWait?.();
      if (!botId) {
        return;
      }
      await client.stopOutputAudio(botId);
    },
    start: async () => {
      stopped = false;
      ended = false;
      const recordingConfig: RecallRecordingConfig = {
        audio_separate_raw: {},
        ...options.recordingConfig,
        realtime_endpoints: [
          {
            events: [
              "audio_separate_raw.data",
              "participant_events.join",
              "participant_events.leave",
              "participant_events.chat_message",
            ],
            type: "websocket",
            url: options.websocketUrl,
          },
          ...(options.recordingConfig?.realtime_endpoints ?? []),
        ],
      };
      const automaticAudioOutput: RecallAutomaticAudioOutput | undefined =
        options.enableSpeak === true
          ? {
              in_call_recording: {
                data: { b64_data: SILENT_MP3_B64, kind: "mp3" },
              },
            }
          : options.enableSpeak === false || options.enableSpeak === undefined
            ? undefined
            : options.enableSpeak;
      const bot = await client.createBot({
        bot_name: options.botName ?? "Deal Referee",
        meeting_url: options.meetingUrl,
        recording_config: recordingConfig,
        ...(automaticAudioOutput
          ? { automatic_audio_output: automaticAudioOutput }
          : {}),
      });
      botId = bot.id;
    },
    stop: async (reason) => {
      stopped = true;
      cancelVerify();
      if (botId) {
        try {
          await client.leaveBot(botId);
        } catch (error) {
          emit("error", { error: error as Error });
        }
      }
      emitEndOnce(reason ?? "stopped");
    },
  };
};
