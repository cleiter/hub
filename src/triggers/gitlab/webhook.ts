import { createHash, timingSafeEqual } from "node:crypto";
import { isDatabaseUnavailableError } from "../../db/errors.js";
import type { ProviderEventAcceptance } from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import type { TriggerSource } from "../index.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import { logProviderEventIntake } from "../audit.js";
import {
  createWebhookHandlerRegistry,
  dispatchWebhookEvents,
  MAX_WEBHOOK_BYTES,
  parseWebhookJsonBody,
} from "../webhook-shared.js";
import { GITLAB_EVENT_KINDS, normalizeGitLabEvent } from "./events.js";

const MAX_HEADER_LENGTH = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface GitLabWebhookSourceOptions {
  /** Returns the stored token hash for a connection, or undefined when there is no such connection. */
  findConnectionSecret(connectionId: string): Promise<{ tokenHash: string } | undefined>;
  accept(input: {
    connectionId: string;
    projectId: number;
    deliveryId: string;
    source: string;
    payload: unknown;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
}

export interface GitLabWebhookEndpoint extends TriggerSource {
  handle(request: Request, connectionId: string | undefined): Promise<Response>;
}

export function createGitLabWebhookSource(
  options: GitLabWebhookSourceOptions,
): GitLabWebhookEndpoint {
  const registry = createWebhookHandlerRegistry();

  async function handle(request: Request, connectionId: string | undefined): Promise<Response> {
    if (connectionId === undefined || !UUID_PATTERN.test(connectionId)) {
      reportGitLabRejection("connection_id_malformed", 400);
      return new Response("Bad Request", { status: 400 });
    }

    try {
      return await handleConnectionRequest(request, connectionId, registry.handlers, options);
    } catch (error) {
      const status = isDatabaseUnavailableError(error) ? 503 : 500;
      reportFailure(
        error,
        { operation: "gitlab.webhook.handle", component: "triggers", provider: "gitlab", status },
        { status },
      );
      return Response.json(
        { error: status === 503 ? "database_unavailable" : "webhook_processing_failed" },
        { status },
      );
    }
  }

  return { handle, start: registry.start, stop: registry.stop };
}

async function handleConnectionRequest(
  request: Request,
  connectionId: string,
  handlers: ReadonlySet<Parameters<GitLabWebhookEndpoint["start"]>[0]>,
  options: GitLabWebhookSourceOptions,
): Promise<Response> {
  const presentedToken = request.headers.get("X-Gitlab-Token") ?? undefined;
  const secret = await options.findConnectionSecret(connectionId);
  // An unknown connection and a wrong token answer identically. Distinguishing them would confirm
  // to anyone guessing ids which ones exist.
  if (
    presentedToken === undefined ||
    secret === undefined ||
    !matchesToken(presentedToken, secret.tokenHash)
  ) {
    reportGitLabRejection("token_verification_failed", 401, presentedToken);
    return new Response("Unauthorized", { status: 401 });
  }

  const eventHeader = readHeader(request, "X-Gitlab-Event");
  if (eventHeader === undefined) {
    reportGitLabRejection("event_header_missing", 400, presentedToken);
    return new Response("Bad Request", { status: 400 });
  }

  const deliveryId = readDeliveryId(request, connectionId);
  if (deliveryId === undefined) {
    reportGitLabRejection("delivery_id_missing", 400, presentedToken);
    return new Response("Bad Request", { status: 400 });
  }

  const body = await readBoundedRequestBody(request, MAX_WEBHOOK_BYTES);
  if (body instanceof Response) return body;
  const parsed = parseWebhookJsonBody({
    body,
    operation: "gitlab.webhook.parse",
    provider: "gitlab",
    scrubValues: [presentedToken],
  });
  if (parsed instanceof Response) return parsed;

  const kind = GITLAB_EVENT_KINDS.get(eventHeader);
  if (kind === undefined) {
    // A hook configured with event types Hub does not handle is a choice on GitLab's side, not an
    // error: acknowledge it so GitLab does not retry, and record why nothing ran.
    return acknowledgeUnhandled(deliveryId, eventHeader, parsed.payload, connectionId, options);
  }

  const event = normalizeGitLabEvent({
    kind,
    deliveryId,
    connectionId,
    payload: parsed.payload,
    receivedAt: new Date(),
  });
  if (event === undefined) {
    reportGitLabRejection("invalid_payload", 400, presentedToken);
    return Response.json({ error: "invalid webhook payload" }, { status: 400 });
  }

  const source = `gitlab.${kind}`;
  const acceptance = await options.accept({
    connectionId,
    projectId: event.project.id,
    deliveryId,
    source,
    payload: event,
    receivedAt: new Date(event.receivedAt),
    ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" } : {}),
  });
  logProviderEventIntake({
    provider: "gitlab",
    source,
    deliveryId,
    resourceId: String(event.project.id),
    acceptance,
  });
  if (acceptance.status !== "accepted") return new Response("OK", { status: 200 });
  return dispatchWebhookEvents(handlers, acceptance.events);
}

async function acknowledgeUnhandled(
  deliveryId: string,
  eventHeader: string,
  payload: unknown,
  connectionId: string,
  options: GitLabWebhookSourceOptions,
): Promise<Response> {
  const source = `gitlab.${eventHeader.replace(/\s+/gu, "_").toLowerCase()}`;
  const acceptance = await options.accept({
    connectionId,
    projectId: readProjectId(payload) ?? 0,
    deliveryId,
    source,
    payload,
    receivedAt: new Date(),
    dropReason: "no_trigger_for_source",
  });
  logProviderEventIntake({ provider: "gitlab", source, deliveryId, acceptance });
  return new Response("OK", { status: 200 });
}

/**
 * `webhook-id` and `Idempotency-Key` are both documented as stable across GitLab's own retries;
 * the second is the older name for the first. `X-Gitlab-Event-UUID` is a last resort for instances
 * that send neither — it is NOT documented as retry-stable, so on such an instance a GitLab-side
 * retry can produce a second receipt and therefore a second run.
 *
 * The id is namespaced by connection because `provider_event_receipts` is unique on
 * (organization_id, delivery_id) alone. `Idempotency-Key` is an arbitrary string whose format
 * GitLab does not guarantee, so an unprefixed value could collide with another connection's or
 * another provider's delivery and be silently swallowed as a duplicate.
 */
function readDeliveryId(request: Request, connectionId: string): string | undefined {
  const rawId =
    readHeader(request, "webhook-id") ??
    readHeader(request, "Idempotency-Key") ??
    readHeader(request, "X-Gitlab-Event-UUID");
  return rawId === undefined ? undefined : `gitlab:${connectionId}:${rawId}`;
}

function readHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name);
  if (value === null) return undefined;
  return value.length === 0 || value.length > MAX_HEADER_LENGTH ? undefined : value;
}

function readProjectId(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const project: unknown = (payload as { project?: unknown }).project;
  if (typeof project !== "object" || project === null) return undefined;
  const id: unknown = (project as { id?: unknown }).id;
  return typeof id === "number" ? id : undefined;
}

/**
 * GitLab sends the secret token in plain text, so the comparison is against the stored hash of the
 * presented value. Hashing first also makes the comparison fixed-width, which keeps it constant
 * time regardless of how long a guessed token is.
 */
function matchesToken(presented: string, tokenHash: string): boolean {
  const actual = Buffer.from(hashGitLabToken(presented), "hex");
  const expected = Buffer.from(tokenHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashGitLabToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A refused delivery is unauthenticated (401) or malformed (400); neither is a server fault. */
function reportGitLabRejection(reason: string, status: number, token?: string): void {
  reportFailure(
    Object.assign(new Error("GitLab webhook request rejected"), { code: reason }),
    { operation: "gitlab.webhook.verify", component: "triggers", provider: "gitlab", status },
    {
      status,
      kind: status === 401 ? "authentication" : "validation",
      scrubValues: token === undefined ? [] : [token],
    },
  );
}
