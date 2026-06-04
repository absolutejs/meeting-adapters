import type { AudioFormat } from "@absolutejs/voice";
import type {
  MeetingParticipant,
  MeetingSource,
  MeetingSourceEventMap,
  SpeakAudio,
} from "@absolutejs/meeting";
import {
  createRecallClient,
  type RecallAutomaticAudioOutput,
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
  if (typeof raw === "string") return JSON.parse(raw) as Record<string, unknown>;
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
      const roster: MeetingParticipant = {
        id: participantId,
        metadata: participant,
        platform: "recall",
        ...(typeof participant.name === "string"
          ? { name: participant.name }
          : {}),
      };
      emit("participant", { participant: roster });
    }

    emit("audio", {
      chunk: decodeBase64(buffer),
      ...(participantId ? { participant: participantId } : {}),
    });
  };

  const ingest: RecallMeetingSource["ingest"] = (raw) => {
    if (stopped) return;
    let message: Record<string, unknown>;
    try {
      message = toMessage(raw);
    } catch (error) {
      emit("error", { error: error as Error });

      return;
    }

    const event = typeof message.event === "string" ? message.event : "";
    const data = asRecord(message.data);

    if (event === "audio_separate_raw.data" || (!event && data.data)) {
      handleAudioFrame(data);

      return;
    }

    if (
      event.endsWith(".done") ||
      event.endsWith("call_ended") ||
      event === "bot.done" ||
      event === "bot.fatal"
    ) {
      emit("end", { reason: event });
    }
  };

  return {
    get botId() {
      return botId;
    },
    format: RECALL_AUDIO_FORMAT,
    ingest,
    on: (event, handler) => {
      listeners[event].add(handler as never);

      return () => {
        listeners[event].delete(handler as never);
      };
    },
    speak: async (audio: SpeakAudio) => {
      if (!botId) {
        throw new Error("recall speak: bot has not joined yet (call start() first)");
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
      await client.outputAudioMp3(botId, encodeBase64(bytes));
    },
    stopSpeaking: async () => {
      // Barge-in: cut the bot's in-progress audio so it doesn't talk over a
      // participant who started speaking. No-op before the bot has joined.
      if (!botId) {
        return;
      }
      await client.stopOutputAudio(botId);
    },
    start: async () => {
      stopped = false;
      const recordingConfig: RecallRecordingConfig = {
        audio_separate_raw: {},
        ...options.recordingConfig,
        realtime_endpoints: [
          {
            events: ["audio_separate_raw.data"],
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
      if (botId) {
        try {
          await client.leaveBot(botId);
        } catch (error) {
          emit("error", { error: error as Error });
        }
      }
      emit("end", { reason: reason ?? "stopped" });
    },
  };
};
