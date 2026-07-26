import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { DiscordMeetingSourceFactoryOptions } from "./source";

/* Adapter package: everything rides the `meeting/source` implementation.
 * `client` is instance-valued (a pre-built discord.js client) → wiring
 * concern; `token` comes from env. */
export const manifest = defineManifest<DiscordMeetingSourceFactoryOptions>()({
  contract: 2,
  identity: {
    accent: "#5865f2",
    category: "voice",
    description:
      "Discord voice `MeetingSource` for `@absolutejs/meeting` — the bot joins a voice channel over native `@discordjs/voice` receive and streams per-user audio (speakers are known exactly, no diarization needed). Supports speaking PCM into the channel and posting chat.",
    docsUrl: "https://github.com/absolutejs/meeting-adapters/tree/main/discord",
    name: "@absolutejs/meeting-discord",
    tagline: "Let the meeting bot join your Discord voice channels.",
  },
  implements: [
    defineImplementation<DiscordMeetingSourceFactoryOptions>()({
      contract: "meeting/source-factory",
      factory: "createDiscordMeetingSourceFactory",
      from: "@absolutejs/meeting-discord",
      requires: {
        env: [
          {
            description:
              "Discord bot token. The app needs the Guilds + GuildVoiceStates intents and Connect permission in the target channel.",
            docsUrl: "https://discord.com/developers/applications",
            key: "DISCORD_BOT_TOKEN",
            secret: true,
          },
        ],
        peers: [
          {
            name: "discord.js",
            range: ">=14.27.0 <15",
            reason: "Discord gateway client",
          },
          {
            name: "@discordjs/voice",
            range: ">=0.19.2 <0.20",
            reason: "voice channel connect + per-user Opus receive",
          },
        ],
      },
      settings: Type.Object({
        guildId: Type.String({
          description: "The Discord server the voice channel belongs to.",
          title: "Server id",
        }),
        leaveWhenAloneMs: Type.Optional(
          Type.Number({
            description:
              "Leave the channel after no human has been present for this many milliseconds. Default 30000; 0 stays until explicitly stopped.",
            minimum: 0,
            title: "Leave when alone after",
          }),
        ),
        readyTimeoutMs: Type.Optional(
          Type.Number({
            description:
              "How long to wait for the voice connection to become ready before failing, in milliseconds. Default 30000.",
            minimum: 1,
            title: "Join timeout",
          }),
        ),
      }),
      title: "Discord voice channel",
      wiring: {
        code: "createDiscordMeetingSourceFactory({ token: ${env.DISCORD_BOT_TOKEN} ?? '', ...${settings} })",
        imports: [
          {
            from: "@absolutejs/meeting-discord",
            names: ["createDiscordMeetingSourceFactory"],
          },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
