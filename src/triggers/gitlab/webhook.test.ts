import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DatabaseUnavailableError } from "../../db/errors.js";
import type { DurableProviderEvent, ProviderEventAcceptance } from "../../db/types.js";
import mergeRequestOpen from "../fixtures/gl-merge-request-open.json" with { type: "json" };
import { createGitLabWebhookSource, hashGitLabToken } from "./webhook.js";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "gitlab-webhook-token";

interface AcceptedInput {
  connectionId: string;
  projectId: number;
  deliveryId: string;
  source: string;
  dropReason?: string;
}

describe("GitLab webhook", () => {
  it("accepts a signed merge request hook and dispatches it once", async () => {
    const accepted: AcceptedInput[] = [];
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = source(accepted);
    await endpoint.start(async (event) => {
      dispatched.push(event);
    });

    const response = await endpoint.handle(request(), CONNECTION_ID);

    assert.equal(response.status, 200);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.source, "gitlab.merge_request");
    assert.equal(accepted[0]?.projectId, 4242);
    assert.equal(dispatched.length, 1);
  });

  it("answers 401 identically for an unknown connection and a wrong or absent token", async () => {
    const endpoint = source([]);

    const wrongToken = await endpoint.handle(request({ token: "wrong" }), CONNECTION_ID);
    const shortToken = await endpoint.handle(request({ token: "x" }), CONNECTION_ID);
    const noToken = await endpoint.handle(request({ token: null }), CONNECTION_ID);
    const unknownConnection = await endpoint.handle(
      request(),
      "22222222-2222-4222-8222-222222222222",
    );

    for (const response of [wrongToken, shortToken, noToken, unknownConnection]) {
      assert.equal(response.status, 401);
      assert.equal(await response.text(), "Unauthorized");
    }
  });

  it("refuses a malformed or absent connection id before looking anything up", async () => {
    let looked = false;
    const endpoint = createGitLabWebhookSource({
      findConnectionSecret: async () => {
        looked = true;
        return undefined;
      },
      accept: () => Promise.reject(new Error("unused")),
    });

    assert.equal((await endpoint.handle(request(), "not-a-uuid")).status, 400);
    assert.equal((await endpoint.handle(request(), undefined)).status, 400);
    assert.equal(looked, false);
  });

  it("namespaces the delivery id and falls back through GitLab's retry-stable headers", async () => {
    const accepted: AcceptedInput[] = [];
    const endpoint = source(accepted);

    await endpoint.handle(request({ headers: { "webhook-id": "primary" } }), CONNECTION_ID);
    await endpoint.handle(request({ headers: { "Idempotency-Key": "legacy" } }), CONNECTION_ID);
    await endpoint.handle(
      request({ headers: { "X-Gitlab-Event-UUID": "fallback" } }),
      CONNECTION_ID,
    );

    assert.deepEqual(
      accepted.map((input) => input.deliveryId),
      [
        `gitlab:${CONNECTION_ID}:primary`,
        `gitlab:${CONNECTION_ID}:legacy`,
        `gitlab:${CONNECTION_ID}:fallback`,
      ],
    );
  });

  it("prefers webhook-id over the older header names", async () => {
    const accepted: AcceptedInput[] = [];
    const endpoint = source(accepted);

    await endpoint.handle(
      request({
        headers: {
          "webhook-id": "primary",
          "Idempotency-Key": "legacy",
          "X-Gitlab-Event-UUID": "fallback",
        },
      }),
      CONNECTION_ID,
    );

    assert.equal(accepted[0]?.deliveryId, `gitlab:${CONNECTION_ID}:primary`);
  });

  it("refuses a delivery carrying none of the identifying headers", async () => {
    const endpoint = source([]);
    const response = await endpoint.handle(request({ headers: {} }), CONNECTION_ID);
    assert.equal(response.status, 400);
  });

  it("refuses a delivery without an event header", async () => {
    const endpoint = source([]);
    const response = await endpoint.handle(request({ event: null }), CONNECTION_ID);
    assert.equal(response.status, 400);
  });

  it("refuses a payload whose body disagrees with the event header", async () => {
    const endpoint = source([]);
    const response = await endpoint.handle(request({ event: "Issue Hook" }), CONNECTION_ID);
    assert.equal(response.status, 400);
  });

  it("acknowledges an event type Hub does not handle and records why nothing ran", async () => {
    const accepted: AcceptedInput[] = [];
    const endpoint = source(accepted);

    const response = await endpoint.handle(request({ event: "Pipeline Hook" }), CONNECTION_ID);

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.dropReason, "no_trigger_for_source");
    assert.equal(accepted[0]?.source, "gitlab.pipeline_hook");
  });

  it("refuses a body larger than the shared webhook cap", async () => {
    const endpoint = source([]);
    const oversized = new Request("https://hub.example.com/api/integrations/gitlab/webhook", {
      method: "POST",
      headers: {
        "X-Gitlab-Token": TOKEN,
        "X-Gitlab-Event": "Merge Request Hook",
        "webhook-id": "oversized",
        "content-length": String(2 * 1_048_576),
      },
      body: "{}",
    });

    assert.equal((await endpoint.handle(oversized, CONNECTION_ID)).status, 413);
  });

  it("refuses a body that is not JSON", async () => {
    const endpoint = source([]);
    const response = await endpoint.handle(request({ body: "{not json" }), CONNECTION_ID);
    assert.equal(response.status, 400);
  });

  it("reports a database outage as retryable rather than as a rejected delivery", async () => {
    const endpoint = createGitLabWebhookSource({
      findConnectionSecret: async () => ({ tokenHash: hashGitLabToken(TOKEN) }),
      accept: () => Promise.reject(new DatabaseUnavailableError("database unavailable")),
    });

    const response = await endpoint.handle(request(), CONNECTION_ID);
    assert.equal(response.status, 503);
  });

  it("drops the handler registry on stop", async () => {
    const endpoint = source([]);
    const dispatched: DurableProviderEvent[] = [];
    await endpoint.start(async (event) => {
      dispatched.push(event);
    });
    await endpoint.stop();

    await endpoint.handle(request(), CONNECTION_ID);
    assert.equal(dispatched.length, 0);
  });
});

function source(accepted: AcceptedInput[]) {
  return createGitLabWebhookSource({
    findConnectionSecret: async (connectionId) =>
      connectionId === CONNECTION_ID ? { tokenHash: hashGitLabToken(TOKEN) } : undefined,
    accept: async (input): Promise<ProviderEventAcceptance> => {
      accepted.push(input);
      if (input.dropReason !== undefined) {
        return { status: "dropped", receiptId: "receipt-1", reason: input.dropReason };
      }
      return {
        status: "accepted",
        receiptId: "receipt-1",
        events: [
          {
            providerEventReceiptId: "receipt-1",
            organizationId: "org-1",
            projectId: "project-1",
            configurationRevisionId: "revision-1",
            source: input.source,
            deliveryId: input.deliveryId,
            receivedAt: input.receivedAt,
            payload: input.payload,
            connectionId: input.connectionId,
            resourceId: String(input.projectId),
          },
        ],
      };
    },
  });
}

function request(
  overrides: {
    token?: string | null;
    event?: string | null;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Request {
  const headers = new Headers(overrides.headers ?? { "webhook-id": "delivery-1" });
  if (overrides.token !== null) headers.set("X-Gitlab-Token", overrides.token ?? TOKEN);
  if (overrides.event !== null)
    headers.set("X-Gitlab-Event", overrides.event ?? "Merge Request Hook");
  return new Request("https://hub.example.com/api/integrations/gitlab/webhook", {
    method: "POST",
    headers,
    body: overrides.body ?? JSON.stringify(mergeRequestOpen),
  });
}
