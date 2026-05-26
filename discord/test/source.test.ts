import { describe, expect, test } from "bun:test";
import {
  createDiscordMeetingSource,
  DISCORD_AUDIO_FORMAT,
  stereoToMono,
} from "../src/index";

describe("stereoToMono", () => {
  test("averages left + right per frame", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(1000, 0);
    buf.writeInt16LE(2000, 2);
    buf.writeInt16LE(-4, 4);
    buf.writeInt16LE(-2, 6);
    const mono = stereoToMono(buf);
    const view = new Int16Array(
      mono.buffer,
      mono.byteOffset,
      mono.byteLength / 2,
    );
    expect(Array.from(view)).toEqual([1500, -3]);
  });

  test("halves the byte length (stereo -> mono)", () => {
    expect(stereoToMono(Buffer.alloc(16)).byteLength).toBe(8);
  });
});

describe("DISCORD_AUDIO_FORMAT", () => {
  test("is mono 16-bit 48 kHz raw PCM", () => {
    expect(DISCORD_AUDIO_FORMAT).toEqual({
      channels: 1,
      container: "raw",
      encoding: "pcm_s16le",
      sampleRateHz: 48000,
    });
  });
});

describe("createDiscordMeetingSource", () => {
  test("exposes the MeetingSource contract", () => {
    const source = createDiscordMeetingSource({
      channelId: "c",
      guildId: "g",
      token: "t",
    });
    expect(source.format).toEqual(DISCORD_AUDIO_FORMAT);
    expect(typeof source.start).toBe("function");
    expect(typeof source.stop).toBe("function");
    const off = source.on("audio", () => {});
    expect(typeof off).toBe("function");
    off();
  });

  test("start() requires a token or client", async () => {
    const source = createDiscordMeetingSource({ channelId: "c", guildId: "g" });
    await expect(source.start()).rejects.toThrow(/token or client/);
  });

  test("stop() emits end even with no active connection", async () => {
    const source = createDiscordMeetingSource({
      channelId: "c",
      guildId: "g",
      token: "t",
    });
    let endReason: string | undefined;
    source.on("end", ({ reason }) => {
      endReason = reason;
    });
    await source.stop("bye");
    expect(endReason).toBe("bye");
  });
});
