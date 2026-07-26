import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { RecallMeetingSourceFactoryOptions } from "./source";

/* Adapter package: everything rides the `meeting/source` implementation.
 * `client` / `fetchImpl` are instance-valued → wiring concerns; `apiKey`
 * comes from env; `meetingUrl` is per-call → a wiring TODO binding. */
export const manifest = defineManifest<RecallMeetingSourceFactoryOptions>()({
  contract: 2,
  identity: {
    accent: "#0ea5e9",
    category: "voice",
    description:
      "Recall.ai `MeetingSource` for `@absolutejs/meeting` — one integration covers Google Meet, Zoom, and Teams. Recall joins the call as a bot and streams per-participant raw PCM to a websocket you host; the adapter decodes it into diarized audio + participant events, tells transient socket drops apart from real call ends via bot-status heartbeats, and can speak mp3 into the call.",
    docsUrl: "https://github.com/absolutejs/meeting-adapters/tree/main/recall",
    name: "@absolutejs/meeting-recall",
    tagline: "Send the meeting bot into Google Meet, Zoom, and Teams calls.",
  },
  implements: [
    defineImplementation<RecallMeetingSourceFactoryOptions>()({
      contract: "meeting/source-factory",
      factory: "createRecallMeetingSourceFactory",
      from: "@absolutejs/meeting-recall",
      requires: {
        env: [
          {
            description:
              "Recall.ai workspace API key. Region-scoped — it only works against the region the workspace lives in.",
            docsUrl: "https://recall.ai",
            key: "RECALL_API_KEY",
            secret: true,
          },
        ],
      },
      settings: Type.Object({
        botName: Type.Optional(
          Type.String({
            description:
              "The name shown for the bot inside the call. Defaults to 'Deal Referee'.",
            title: "Bot display name",
          }),
        ),
        enableSpeak: Type.Optional(
          Type.Boolean({
            description:
              "Arm the bot to play audio into the call (Recall requires this at join time). Leave off for a listen-only bot.",
            title: "Bot can speak",
          }),
        ),
        region: Type.Optional(
          Type.Union(
            [
              Type.Literal("us-west-2"),
              Type.Literal("us-east-1"),
              Type.Literal("eu-central-1"),
              Type.Literal("ap-northeast-1"),
            ],
            {
              description:
                "The Recall region your workspace lives in. Defaults to us-west-2.",
              title: "Recall region",
            },
          ),
        ),
        websocketUrl: Type.String({
          description:
            "Public wss:// endpoint on your server that Recall streams call audio to. Route frames by bot/session and forward them to the matching source's ingest().",
          examples: ["wss://yoursite.com/meeting/audio"],
          format: "uri",
          title: "Realtime audio endpoint",
        }),
      }),
      title: "Recall.ai (Google Meet / Zoom / Teams)",
      wiring: {
        code: "createRecallMeetingSourceFactory({ apiKey: ${env.RECALL_API_KEY} ?? '', ...${settings} })",
        imports: [
          {
            from: "@absolutejs/meeting-recall",
            names: ["createRecallMeetingSourceFactory"],
          },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
