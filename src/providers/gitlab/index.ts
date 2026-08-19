import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AuthServer } from "../../auth/server.js";
import type { Database, GitLabConnectionRecord } from "../../db/types.js";
import {
  connectionActionFailure,
  manageConnectionAccess,
  requiredConnectionId,
} from "../../connections/shared.js";
import { slugify } from "../../slug.js";
import { createGitLabTriggerProvider } from "../../triggers/gitlab/provider.js";
import { createGitLabWebhookSource, hashGitLabToken } from "../../triggers/gitlab/webhook.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";

export interface CreateGitLabRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  publicBaseUrl: string;
}

const CreateConnectionSchema = z.object({
  organizationSlug: z.string().min(1),
  label: z.string().min(1).max(120),
  baseUrl: z.string().url(),
});

/**
 * GitLab needs no instance-wide credentials, so unlike GitHub, Slack and Discord it has nothing to
 * configure on the Apps page and is always registered. What it needs instead is a database to hold
 * per-connection tokens and a public base URL to build the webhook address a user pastes into
 * GitLab.
 */
export function createGitLabRegistration(
  options: CreateGitLabRegistrationOptions,
): ProviderRegistration {
  const { database, auth } = options;
  if (database === null) {
    return {
      connection: { name: "gitlab", status: () => ({ status: "notConfigured" }), actions: {} },
      triggerProviders: [],
      sources: [],
      outputs: [],
      requests: [],
    };
  }

  const webhook = createGitLabWebhookSource({
    findConnectionSecret: (connectionId) => database.findGitLabConnectionSecret(connectionId),
    accept: (input) => database.acceptGitLabEvent(input),
  });

  return {
    connection: gitlabConnectionStatus(
      auth === null
        ? {}
        : connectionActions({ database, auth, publicBaseUrl: options.publicBaseUrl }),
    ),
    triggerProviders: [
      ({ configurationStoreForProject }) =>
        createGitLabTriggerProvider({ configurationStoreForProject }),
    ],
    sources: [webhook],
    // Inbound only in v1: Hub mints no GitLab credential, so it registers no output that could
    // write back. The connected host does any writing, with credentials it already holds.
    outputs: [],
    requests: [
      {
        name: "gitlab.webhook",
        handle: (request) => webhook.handle(request, readConnectionIdFromPath(request)),
      },
    ],
  };
}

function gitlabConnectionStatus(
  actions: ProviderConnectionRegistration["actions"],
): ProviderConnectionRegistration {
  return {
    name: "gitlab",
    status: (connections) =>
      connections.gitlab.length === 0
        ? { status: "disconnected" as const }
        : { status: "connected" as const, connections: connections.gitlab },
    actions,
  };
}

function connectionActions(options: {
  database: Database;
  auth: AuthServer;
  publicBaseUrl: string;
}): ProviderConnectionRegistration["actions"] {
  return {
    create: async (request: Request): Promise<Response> => {
      const rejected = options.auth.rejectCookieMutation(request);
      if (rejected !== undefined) return rejected;
      let token: string | undefined;
      try {
        const access = await manageConnectionAccess(options.auth, options.database, request);
        const input = CreateConnectionSchema.parse(await request.json());
        token = newWebhookToken();
        const connection = await options.database.createGitLabConnection({
          organizationId: access.tenant.organization.id,
          slug: `${slugify(input.label, "connection")}-gitlab`,
          label: input.label,
          baseUrl: input.baseUrl,
          tokenHash: hashGitLabToken(token),
          createdByUserId: access.account.account.id,
        });
        return revealToken(connection, token, options.publicBaseUrl);
      } catch (error) {
        return connectionActionFailure(scrubbed(error, token), "gitlab", "create");
      }
    },
    rotate: async (request: Request): Promise<Response> => {
      const rejected = options.auth.rejectCookieMutation(request);
      if (rejected !== undefined) return rejected;
      let token: string | undefined;
      try {
        const access = await manageConnectionAccess(options.auth, options.database, request);
        token = newWebhookToken();
        const rotated = await options.database.rotateGitLabConnectionToken({
          organizationId: access.tenant.organization.id,
          connectionId: requiredConnectionId(request),
          tokenHash: hashGitLabToken(token),
        });
        if (!rotated) return Response.json({ error: "not_found" }, { status: 404 });
        return noStore(Response.json({ token }));
      } catch (error) {
        return connectionActionFailure(scrubbed(error, token), "gitlab", "rotate");
      }
    },
    disconnect: async (request: Request): Promise<Response> => {
      const rejected = options.auth.rejectCookieMutation(request);
      if (rejected !== undefined) return rejected;
      try {
        const access = await manageConnectionAccess(options.auth, options.database, request);
        await options.database.disconnectConnection("gitlab", requiredConnectionId(request), {
          sessionId: access.account.session.id,
          userId: access.account.account.id,
          membershipId: access.tenant.membership.id,
          organizationId: access.tenant.organization.id,
          returnRoute: access.returnRoute,
        });
        return Response.json({ result: "gitlab_disconnected" });
      } catch (error) {
        return connectionActionFailure(error, "gitlab", "disconnect");
      }
    },
  };
}

/**
 * The only moment the token is readable. Only its hash is stored, so a user who loses it has to
 * rotate rather than look it up — which is the property that makes a database dump useless against
 * the webhook endpoint.
 */
function revealToken(
  connection: GitLabConnectionRecord,
  token: string,
  publicBaseUrl: string,
): Response {
  return noStore(
    Response.json({
      connectionId: connection.id,
      label: connection.label,
      webhookUrl: new URL(
        `/api/integrations/gitlab/webhook/${connection.id}`,
        publicBaseUrl,
      ).toString(),
      token,
    }),
  );
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function newWebhookToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A failure raised after the token was generated must not carry it into a report. Hub never puts
 * the token in a message it builds, but a driver or validation library could echo the request it
 * came from, so the value is removed before the error is handed on.
 */
function scrubbed(error: unknown, token: string | undefined): unknown {
  if (token === undefined || !(error instanceof Error)) return error;
  error.message = error.message.split(token).join("[redacted]");
  return error;
}

/**
 * The connection id is the last path segment of the webhook URL. Reading it here keeps the generic
 * provider-request contract — which passes only the request — unchanged.
 */
function readConnectionIdFromPath(request: Request): string | undefined {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1);
}
