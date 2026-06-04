/**
 * Minimal typed client for the Recall.ai bot API.
 *
 * Recall is region-scoped: a workspace lives in exactly one region and its key
 * only works against that region's host. Pass `region` (shorthand) or a full
 * `baseUrl`. Auth is the bare API key in the `Authorization` header.
 */

export type RecallRegion =
  | "us-west-2"
  | "us-east-1"
  | "eu-central-1"
  | "ap-northeast-1";

const REGION_BASE_URL: Record<RecallRegion, string> = {
  "ap-northeast-1": "https://ap-northeast-1.recall.ai/api/v1",
  "eu-central-1": "https://eu-central-1.recall.ai/api/v1",
  "us-east-1": "https://us-east-1.recall.ai/api/v1",
  "us-west-2": "https://us-west-2.recall.ai/api/v1",
};

export type RecallClientOptions = {
  /** Recall workspace API key. */
  apiKey: string;
  /** Full base URL including `/api/v1`. Overrides `region` when set. */
  baseUrl?: string;
  /** Region shorthand. Defaults to "us-west-2". Ignored when `baseUrl` is set. */
  region?: RecallRegion;
  /** Inject a fetch implementation (tests, custom agents). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export type RecallRealtimeEndpoint = {
  type: "websocket";
  /** Public wss:// URL Recall connects out to and streams events to. */
  url: string;
  /** Realtime event names to deliver, e.g. ["audio_separate_raw.data"]. */
  events: string[];
};

export type RecallRecordingConfig = {
  /** Enable per-participant raw PCM (mono 16-bit LE @ 16 kHz). */
  audio_separate_raw?: Record<string, never>;
  /** Where Recall streams realtime events. */
  realtime_endpoints?: RecallRealtimeEndpoint[];
  [key: string]: unknown;
};

/**
 * Initial audio Recall plays automatically when the bot joins. Enabling
 * `automatic_audio_output` (i.e. passing this on create) is what lights up the
 * `output_audio` endpoint for that bot — you cannot speak through a bot that
 * was created without it.
 */
export type RecallAutomaticAudioOutput = {
  in_call_recording: {
    data: { kind: "mp3"; b64_data: string };
  };
};

export type RecallCreateBotInput = {
  /** Meeting URL the bot joins (Google Meet / Zoom / Teams). */
  meeting_url: string;
  /** Display name shown for the bot in the call. */
  bot_name?: string;
  recording_config?: RecallRecordingConfig;
  /** Audio Recall plays on join — also the toggle that enables output_audio. */
  automatic_audio_output?: RecallAutomaticAudioOutput;
  [key: string]: unknown;
};

export type RecallStatusChange = {
  code: string;
  message?: string | null;
  created_at: string;
  sub_code?: string | null;
};

export type RecallBot = {
  id: string;
  meeting_url?: unknown;
  bot_name?: string;
  status_changes?: RecallStatusChange[];
  recordings?: unknown[];
  [key: string]: unknown;
};

export class RecallApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(`Recall ${method} ${path} failed: ${status} ${body}`.trim());
    this.name = "RecallApiError";
    this.status = status;
    this.body = body;
  }
}

export type RecallClient = {
  readonly baseUrl: string;
  createBot: (input: RecallCreateBotInput) => Promise<RecallBot>;
  getBot: (botId: string) => Promise<RecallBot>;
  listBots: (
    params?: Record<string, string | number>,
  ) => Promise<{ results?: RecallBot[]; next?: string | null } & Record<string, unknown>>;
  /** Make the bot leave the call (keeps the bot record + recordings). */
  leaveBot: (botId: string) => Promise<RecallBot>;
  /** Delete the bot record entirely. */
  deleteBot: (botId: string) => Promise<void>;
  /**
   * Play an MP3 (base64) through the bot into the call. Requires the bot to
   * have been created with `automatic_audio_output`; otherwise Recall returns
   * a 400/403.
   */
  outputAudioMp3: (botId: string, mp3Base64: string) => Promise<void>;
  /**
   * Stop any in-progress output audio immediately — for barge-in / ducking when
   * a participant starts talking while the bot is speaking. Idempotent: a no-op
   * if nothing is playing.
   */
  stopOutputAudio: (botId: string) => Promise<void>;
};

export const createRecallClient = (
  options: RecallClientOptions,
): RecallClient => {
  if (!options.apiKey) {
    throw new Error("createRecallClient: apiKey is required");
  }
  const baseUrl = (
    options.baseUrl ?? REGION_BASE_URL[options.region ?? "us-west-2"]
  ).replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  const request = async (
    path: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    const res = await doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: options.apiKey,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new RecallApiError(method, path, res.status, body);
    }

    return res;
  };

  return {
    baseUrl,
    createBot: async (input) =>
      (await request("/bot/", {
        body: JSON.stringify(input),
        method: "POST",
      }).then((res) => res.json())) as RecallBot,
    deleteBot: async (botId) => {
      await request(`/bot/${botId}/`, { method: "DELETE" });
    },
    getBot: async (botId) =>
      (await request(`/bot/${botId}/`).then((res) => res.json())) as RecallBot,
    leaveBot: async (botId) =>
      (await request(`/bot/${botId}/leave_call/`, {
        body: "{}",
        method: "POST",
      }).then((res) => res.json())) as RecallBot,
    listBots: async (params) => {
      const qs = params
        ? `?${new URLSearchParams(
            Object.fromEntries(
              Object.entries(params).map(([key, value]) => [key, String(value)]),
            ),
          ).toString()}`
        : "";

      return request(`/bot/${qs}`).then((res) => res.json());
    },
    outputAudioMp3: async (botId, mp3Base64) => {
      await request(`/bot/${botId}/output_audio/`, {
        body: JSON.stringify({ kind: "mp3", b64_data: mp3Base64 }),
        method: "POST",
      });
    },
    stopOutputAudio: async (botId) => {
      await request(`/bot/${botId}/output_audio/`, { method: "DELETE" });
    },
  };
};
