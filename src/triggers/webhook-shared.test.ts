import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { DurableProviderEvent } from "../db/types.js";
import type { TriggerHandler } from "./index.js";
import {
  createWebhookHandlerRegistry,
  dispatchWebhookEvents,
  MAX_WEBHOOK_BYTES,
  parseWebhookJsonBody,
} from "./webhook-shared.js";

describe("shared webhook helpers", () => {
  it("caps webhook bodies at one mebibyte for every provider", () => {
    assert.equal(MAX_WEBHOOK_BYTES, 1_048_576);
  });

  it("parses a UTF-8 JSON body into a wrapped payload", () => {
    const parsed = parseWebhookJsonBody({
      body: new TextEncoder().encode('{"object_kind":"merge_request"}'),
      operation: "test.parse",
      provider: "github",
      scrubValues: [],
    });

    assert.ok(!(parsed instanceof Response));
    assert.deepEqual(parsed.payload, { object_kind: "merge_request" });
  });

  it("rejects malformed JSON with 400 rather than throwing", async () => {
    const parsed = parseWebhookJsonBody({
      body: new TextEncoder().encode("{not json"),
      operation: "test.parse",
      provider: "github",
      scrubValues: ["secret"],
    });

    assert.ok(parsed instanceof Response);
    assert.equal(parsed.status, 400);
    assert.deepEqual(await parsed.json(), { error: "request body must be valid JSON" });
  });

  it("rejects invalid UTF-8 with 400 instead of substituting replacement characters", () => {
    const parsed = parseWebhookJsonBody({
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
      operation: "test.parse",
      provider: "slack",
      scrubValues: [],
    });

    assert.ok(parsed instanceof Response);
    assert.equal(parsed.status, 400);
  });

  it("adds and clears handlers through the registry lifecycle", async () => {
    const registry = createWebhookHandlerRegistry();
    const handler: TriggerHandler = async () => {};

    await registry.start(handler);
    assert.equal(registry.handlers.size, 1);
    await registry.stop();
    assert.equal(registry.handlers.size, 0);
  });

  it("fans every accepted event out to every handler and answers 200", async () => {
    const registry = createWebhookHandlerRegistry();
    const seen: string[] = [];
    await registry.start(async (event) => {
      seen.push(`a:${event.deliveryId}`);
    });
    await registry.start(async (event) => {
      seen.push(`b:${event.deliveryId}`);
    });

    const response = await dispatchWebhookEvents(registry.handlers, [
      providerEvent("one"),
      providerEvent("two"),
    ]);

    assert.equal(response.status, 200);
    assert.deepEqual(seen.sort(), ["a:one", "a:two", "b:one", "b:two"]);
  });

  it("answers 200 with no handlers registered", async () => {
    const registry = createWebhookHandlerRegistry();
    const response = await dispatchWebhookEvents(registry.handlers, [providerEvent("one")]);
    assert.equal(response.status, 200);
  });
});

function providerEvent(deliveryId: string): DurableProviderEvent {
  return {
    providerEventReceiptId: "receipt-1",
    organizationId: "org-1",
    projectId: "project-1",
    configurationRevisionId: "revision-1",
    source: "github.issue_comment",
    deliveryId,
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    payload: {},
    connectionId: null,
    resourceId: null,
  };
}
