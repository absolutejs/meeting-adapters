import { expect, mock, test } from "bun:test";
let joined: any;
const connection = {
  on() {},
  receiver: { speaking: { on() {} } },
  destroy() {},
};
mock.module("@discordjs/voice", () => ({
  AudioPlayerStatus: { Idle: "idle" },
  createAudioPlayer() {},
  createAudioResource() {},
  EndBehaviorType: { AfterSilence: 1 },
  entersState: async () => connection,
  joinVoiceChannel: (options: any) => {
    joined = options;
    return connection;
  },
  StreamType: { Raw: "raw" },
  VoiceConnectionStatus: { Ready: "ready", Disconnected: "disconnected" },
}));
const { createDiscordMeetingSource } = await import("../src/source");
test("joining permits both receiving audio and requested playback", async () => {
  const channel = {
    isVoiceBased: () => true,
    guild: { voiceAdapterCreator: {} },
    members: { filter: () => ({ size: 1 }) },
  };
  const client = {
    channels: { fetch: async () => channel, cache: { get: () => channel } },
    on() {},
    off() {},
  };
  const source = createDiscordMeetingSource({
    client: client as never,
    guildId: "guild",
    channelId: "voice",
    leaveWhenAloneMs: 0,
  });
  await source.start();
  expect(joined.guildId).toBe("guild");
  expect(joined.channelId).toBe("voice");
  expect(joined.selfDeaf).toBe(false);
  expect(joined.selfMute).toBe(false);
  await source.stop();
});
