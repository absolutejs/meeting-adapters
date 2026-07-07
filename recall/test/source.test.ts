import { describe, expect, test } from "bun:test";
import {
  createRecallClient,
  createRecallMeetingSource,
  RECALL_AUDIO_FORMAT,
  estimateMp3DurationMs,
} from "../src/index";

describe("createRecallMeetingSource ingest", () => {
  test("decodes an audio_separate_raw frame into a diarized audio chunk", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const frame = JSON.stringify({
      data: {
        data: { buffer: Buffer.from(pcm).toString("base64") },
        participant: { id: 42, name: "Alice" },
      },
      event: "audio_separate_raw.data",
    });
    const source = createRecallMeetingSource({
      apiKey: "x",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      websocketUrl: "wss://example/ws",
    });

    const audio: number[][] = [];
    const speakers: string[] = [];
    let participantName: unknown;
    source.on("audio", ({ chunk, participant }) => {
      audio.push(Array.from(new Uint8Array(chunk as ArrayBufferLike)));
      if (participant) speakers.push(participant);
    });
    source.on("participant", ({ participant }) => {
      participantName = participant.name;
    });

    source.ingest(frame);

    expect(audio).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);
    expect(speakers).toEqual(["42"]);
    expect(participantName).toBe("Alice");
  });

  test("announces each speaker exactly once", () => {
    const source = createRecallMeetingSource({
      apiKey: "x",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      websocketUrl: "wss://example/ws",
    });
    let participantEvents = 0;
    source.on("participant", () => {
      participantEvents += 1;
    });
    const frame = (id: number) =>
      JSON.stringify({
        data: {
          data: { buffer: Buffer.from([0, 0]).toString("base64") },
          participant: { id },
        },
        event: "audio_separate_raw.data",
      });
    source.ingest(frame(1));
    source.ingest(frame(1));
    source.ingest(frame(2));
    expect(participantEvents).toBe(2);
  });

  test("emits end on a terminal bot event", () => {
    const source = createRecallMeetingSource({
      apiKey: "x",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      websocketUrl: "wss://example/ws",
    });
    let endReason: string | undefined;
    source.on("end", ({ reason }) => {
      endReason = reason;
    });
    source.ingest(JSON.stringify({ event: "bot.done" }));
    expect(endReason).toBe("bot.done");
  });

  test("exposes Recall's mono 16-bit 16 kHz PCM format", () => {
    expect(RECALL_AUDIO_FORMAT).toEqual({
      channels: 1,
      container: "raw",
      encoding: "pcm_s16le",
      sampleRateHz: 16000,
    });
  });
});

describe("createRecallMeetingSource start", () => {
  test("creates a bot whose realtime endpoint points at the websocket URL", async () => {
    let body: Record<string, unknown> | null = null;
    let calledUrl = "";
    let method = "";
    const client = createRecallClient({
      apiKey: "secret-key",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calledUrl = String(url);
        method = String(init.method);
        body = JSON.parse(String(init.body));

        return new Response(JSON.stringify({ id: "bot_123" }), {
          headers: { "content-type": "application/json" },
          status: 201,
        });
      }) as unknown as typeof fetch,
      region: "us-west-2",
    });
    const source = createRecallMeetingSource({
      botName: "Deal Referee",
      client,
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      websocketUrl: "wss://pub.example/recall",
    });

    await source.start();

    expect(calledUrl).toBe("https://us-west-2.recall.ai/api/v1/bot/");
    expect(method).toBe("POST");
    expect(source.botId).toBe("bot_123");
    const config = (
      body as unknown as { recording_config: Record<string, unknown> }
    ).recording_config;
    expect(config.audio_separate_raw).toEqual({});
    expect(config.realtime_endpoints).toEqual([
      {
        events: [
          "audio_separate_raw.data",
          "participant_events.join",
          "participant_events.leave",
          "participant_events.chat_message",
        ],
        type: "websocket",
        url: "wss://pub.example/recall",
      },
    ]);
  });
});

describe("speak queue", () => {
  const FRAME_HEADER = [0xff, 0xfb, 0x90, 0x00]; // MPEG-1 L3, 128 kbps

  test("estimateMp3DurationMs reads the first-frame bitrate", () => {
    const bytes = new Uint8Array(16_000);
    bytes.set(FRAME_HEADER, 0);
    // 16000 bytes * 8 bits / 128 kbps = 1000 ms
    expect(estimateMp3DurationMs(bytes)).toBe(1000);
    // No header → 128 kbps fallback.
    expect(estimateMp3DurationMs(new Uint8Array(1600))).toBe(100);
  });

  const buildSpeakingSource = async () => {
    const sends: number[] = [];
    const client = createRecallClient({
      apiKey: "secret-key",
      fetchImpl: (async (url: string) => {
        if (String(url).includes("output_audio")) sends.push(Date.now());

        return new Response(JSON.stringify({ id: "bot_123" }), {
          headers: { "content-type": "application/json" },
          status: 201,
        });
      }) as unknown as typeof fetch,
      region: "us-west-2",
    });
    const source = createRecallMeetingSource({
      botName: "Deal Referee",
      client,
      enableSpeak: true,
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      websocketUrl: "wss://pub.example/recall",
    });
    await source.start();

    return { sends, source };
  };

  test("concurrent speaks serialize on estimated playback", async () => {
    const { sends, source } = await buildSpeakingSource();
    // ~100 ms each at the 128 kbps fallback.
    const clip = new Uint8Array(1600);
    await Promise.all([
      source.speak({ data: clip, format: "mp3" }),
      source.speak({ data: clip, format: "mp3" }),
    ]);
    expect(sends).toHaveLength(2);
    const gap = (sends[1] ?? 0) - (sends[0] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(80);
  });

  test("stopSpeaking drops the queued send and releases the wait", async () => {
    const { sends, source } = await buildSpeakingSource();
    const clip = new Uint8Array(160_000); // ~10 s estimated
    const first = source.speak({ data: clip, format: "mp3" });
    const second = source.speak({ data: clip, format: "mp3" });
    const started = Date.now();
    await source.stopSpeaking();
    await Promise.all([first, second]);
    // Only the first clip was ever sent; the queued one no-oped, and nothing
    // waited out the 10 s estimate.
    expect(sends).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
