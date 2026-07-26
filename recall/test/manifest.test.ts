import { describe, expect, test } from "bun:test";
import { manifest } from "../src/manifest";

describe("Recall manifest", () => {
  test("implements a dynamic source factory without a placeholder meeting URL", () => {
    const implementation = manifest.implements[0];

    expect(implementation?.contract).toBe("meeting/source-factory");
    expect(implementation?.wiring.code).toContain(
      "createRecallMeetingSourceFactory",
    );
    expect(implementation?.wiring.code).not.toContain("meetingUrl = ''");
  });

  test("requires the host websocket used for realtime audio", () => {
    const implementation = manifest.implements[0];

    expect(implementation?.settings.required).toContain("websocketUrl");
  });
});
