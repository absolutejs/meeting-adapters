import { expect, test } from "bun:test";
import { createRecallClient, RecallApiError } from "../src/client";

test("recorded media deletion uses POST delete_media, independently of scheduled cancellation", async () => {
  const requests: { url: string; method: string }[] = [];
  const client = createRecallClient({
    apiKey: "test-key",
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  await client.deleteBotMedia("recorded-bot");
  await client.deleteBot("scheduled-bot");
  expect(requests).toEqual([
    { url: `${client.baseUrl}/bot/recorded-bot/delete_media/`, method: "POST" },
    { url: `${client.baseUrl}/bot/scheduled-bot/`, method: "DELETE" },
  ]);
});

test("media deletion propagates provider errors so cleanup is not reported as successful", async () => {
  const client = createRecallClient({
    apiKey: "test-key",
    fetchImpl: (async () =>
      new Response("not ready", { status: 409 })) as typeof fetch,
  });
  await expect(client.deleteBotMedia("recorded-bot")).rejects.toBeInstanceOf(
    RecallApiError,
  );
});
