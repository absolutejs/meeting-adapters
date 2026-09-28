import { expect, test } from "bun:test";
import { estimateMp3DurationMs } from "../src/source";

// A run of identical Layer III frames: 4-byte header, zero-filled body.
const frames = (header: number[], length: number, count: number) => {
  const out = new Uint8Array(length * count);
  for (let f = 0; f < count; f += 1) out.set(header, f * length);
  return out;
};

test("MPEG-2 frames (Deepgram Aura: 48 kbps, 24 kHz) are timed with the MPEG-2 tables", () => {
  // 576 samples at 24 kHz = 24 ms per 144-byte frame.
  const clip = frames([0xff, 0xf3, 0x64, 0xc4], 144, 100);
  expect(Math.round(estimateMp3DurationMs(clip))).toBe(2400);
});

test("MPEG-1 frames (128 kbps, 44.1 kHz) and a leading ID3 tag", () => {
  const audio = frames([0xff, 0xfb, 0x90, 0x64], 417, 50);
  const id3 = new Uint8Array([
    0x49,
    0x44,
    0x33,
    4,
    0,
    0,
    0,
    0,
    0,
    10,
    ...new Array(10).fill(0),
  ]);
  const clip = new Uint8Array(id3.length + audio.length);
  clip.set(id3);
  clip.set(audio, id3.length);
  // 1152 samples at 44.1 kHz per frame.
  expect(Math.round(estimateMp3DurationMs(clip))).toBe(
    Math.round((50 * 1152 * 1000) / 44100),
  );
});

test("bytes with no frames fall back to 128 kbps", () => {
  expect(estimateMp3DurationMs(new Uint8Array(16000))).toBe(1000);
});
