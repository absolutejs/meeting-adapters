import { describe, expect, test } from "bun:test";
import { manifest } from "../src/manifest";

describe("Discord manifest", () => {
  test("implements a dynamic source factory", () => {
    const implementation = manifest.implements[0];

    expect(implementation?.contract).toBe("meeting/source-factory");
    expect(implementation?.wiring.code).toContain(
      "createDiscordMeetingSourceFactory",
    );
  });

  test("keeps the voice channel out of static package settings", () => {
    const properties = manifest.implements[0]?.settings.properties;

    expect(properties).not.toHaveProperty("channelId");
    expect(properties).toHaveProperty("guildId");
  });
});
