import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { mattermostStartRefusal } from "../providers/mattermost/refusals.js";
import { handleConnections } from "../server/runtime.js";
import {
  CONNECTION_PROVIDERS,
  connectionProviderName,
  type ConnectionProvider,
} from "./result-contract.js";

export type { ConnectionProvider } from "./result-contract.js";

const githubStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({
    status: z.enum(["connected", "suspended"]),
  }),
]);
const discordStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({
    status: z.literal("connected"),
  }),
]);
const slackStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("requiresReauthorization") }),
  z.object({
    status: z.literal("connected"),
  }),
]);
const linearStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("requiresReauthorization") }),
  z.object({ status: z.literal("connected") }),
]);
const mattermostStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({
    status: z.literal("connected"),
  }),
]);
/**
 * GitLab needs no instance-wide credentials, so unlike the others it is never `notConfigured` — an
 * organization either has connections or it does not.
 */
const gitlabStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("connected") }),
]);
export const connectionStatusSchema = z.object({
  canManage: z.boolean(),
  github: githubStatusSchema,
  discord: discordStatusSchema,
  slack: slackStatusSchema,
  linear: linearStatusSchema,
  mattermost: mattermostStatusSchema,
  gitlab: gitlabStatusSchema,
});
const scopeSchema = z.object({
  organizationSlug: z.string().min(1),
  projectSlug: z.string().min(1).optional(),
});
const providerSchema = scopeSchema.extend({
  provider: z.enum(CONNECTION_PROVIDERS),
});
/** GitLab has no authorization flow to start: a connection is created in Hub, not granted by GitLab. */
const startProviderSchema = scopeSchema.extend({
  provider: z.enum(["github", "discord", "slack", "linear", "mattermost"]),
});
const disconnectSchema = providerSchema.extend({ connectionId: z.string().uuid() });
/**
 * GitHub, Slack, and Discord send the admin to the provider to authorize. Mattermost has no
 * such round trip — Hub already holds the bot credential — so starting a connection completes
 * it, and the surface has to be able to tell the two answers apart.
 */
const startSchema = z.union([
  z.object({ url: z.string().url() }),
  z.object({ connected: z.array(z.string()) }),
]);
export type ConnectionStartResult = z.infer<typeof startSchema>;
const createGitLabSchema = scopeSchema.extend({
  label: z.string().min(1).max(120),
  baseUrl: z.string().url(),
});
const rotateGitLabSchema = scopeSchema.extend({ connectionId: z.string().uuid() });
const revealedGitLabConnectionSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string(),
  webhookUrl: z.string().url(),
  token: z.string().min(1),
});
const rotatedGitLabTokenSchema = z.object({ token: z.string().min(1) });

export type RevealedGitLabConnection = z.infer<typeof revealedGitLabConnectionSchema>;

export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type ConnectionDisconnectResult = `${ConnectionProvider}_disconnected`;

export const connectionStatus = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<Result<ConnectionStatus>> => {
    try {
      const response = await handleConnections(
        operationRequest("GET", "/connections", data),
        "status",
      );
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.status",
          response,
          "Hub couldn't load this organization's connections. Reload the page.",
          data,
        );
      }
      return respondOk(connectionStatusSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.status", data), {
        fallback: "Hub couldn't load this organization's connections. Reload the page.",
      });
    }
  });

export const startConnection = createServerFn({ method: "POST" })
  .validator(startProviderSchema)
  .handler(async ({ data }): Promise<Result<ConnectionStartResult>> => {
    const name = connectionProviderName(data.provider);
    try {
      const operation = START_OPERATIONS[data.provider];
      const response = await handleConnections(
        operationRequest("POST", "/connections/start", data),
        operation,
      );
      if (response.status === 403) {
        return connectionResponseFailure(
          "connection.start",
          response,
          `You don't have permission to start ${name}.`,
          data,
        );
      }
      if (!response.ok) {
        // Mattermost binds the bot's teams directly, so a refusal here has a specific cause the
        // operator can act on — saying "check provider availability" would send them looking in
        // the wrong place.
        const specific =
          response.status === 409 ? await mattermostStartRefusal(response) : undefined;
        return connectionResponseFailure(
          "connection.start",
          response,
          specific ??
            `Hub couldn't start the ${name} connection. Check the app status and provider availability before starting again.`,
          data,
        );
      }
      return respondOk(startSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.start", data), {
        fallback: `Hub couldn't start the ${name} connection. Check the app status and provider availability before starting again.`,
      });
    }
  });

export const disconnectConnection = createServerFn({ method: "POST" })
  .validator(disconnectSchema)
  .handler(async ({ data }): Promise<Result<{ result: ConnectionDisconnectResult }>> => {
    const name = connectionProviderName(data.provider);
    try {
      const operation = DISCONNECT_OPERATIONS[data.provider];
      const response = await handleConnections(
        operationRequest("POST", "/connections/disconnect", data, data.connectionId),
        operation,
      );
      if (response.status === 403) {
        return connectionResponseFailure(
          "connection.disconnect",
          response,
          `You don't have permission to disconnect ${name}.`,
          data,
        );
      }
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.disconnect",
          response,
          `Hub couldn't disconnect ${name}. Reload its connection status before disconnecting again.`,
          data,
        );
      }
      return respondOk({ result: `${data.provider}_disconnected` as const });
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.disconnect", data), {
        fallback: `Hub couldn't disconnect ${name}. Reload its connection status before disconnecting again.`,
      });
    }
  });

/**
 * The token is readable exactly once, in this response. Hub stores only its hash, so a token that
 * is not written down where GitLab can be given it has to be replaced by rotating.
 */
export const createGitLabConnection = createServerFn({ method: "POST" })
  .validator(createGitLabSchema)
  .handler(async ({ data }): Promise<Result<RevealedGitLabConnection>> => {
    const message =
      "Hub couldn't create the GitLab connection. Check the instance URL and try again.";
    try {
      const response = await handleConnections(
        operationRequest("POST", "/connections/gitlab", data, undefined, {
          organizationSlug: data.organizationSlug,
          label: data.label,
          baseUrl: data.baseUrl,
        }),
        "gitlabCreate",
      );
      if (!response.ok) {
        return connectionResponseFailure("connection.gitlab.create", response, message, {
          ...data,
          provider: "gitlab",
        });
      }
      return respondOk(revealedGitLabConnectionSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(
        error,
        connectionContext("connection.gitlab.create", { ...data, provider: "gitlab" }),
        { fallback: message },
      );
    }
  });

export const rotateGitLabConnectionToken = createServerFn({ method: "POST" })
  .validator(rotateGitLabSchema)
  .handler(async ({ data }): Promise<Result<{ token: string }>> => {
    const message =
      "Hub couldn't issue a new token for this GitLab connection. Reload its status and try again.";
    try {
      const response = await handleConnections(
        operationRequest("POST", "/connections/gitlab/rotate", data, data.connectionId, {
          organizationSlug: data.organizationSlug,
        }),
        "gitlabRotate",
      );
      if (!response.ok) {
        return connectionResponseFailure("connection.gitlab.rotate", response, message, {
          ...data,
          provider: "gitlab",
        });
      }
      return respondOk(rotatedGitLabTokenSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(
        error,
        connectionContext("connection.gitlab.rotate", { ...data, provider: "gitlab" }),
        { fallback: message },
      );
    }
  });

const START_OPERATIONS = {
  github: "githubStart",
  discord: "discordStart",
  slack: "slackStart",
  linear: "linearStart",
  mattermost: "mattermostStart",
} as const;

const DISCONNECT_OPERATIONS = {
  github: "githubDisconnect",
  discord: "discordDisconnect",
  slack: "slackDisconnect",
  linear: "linearDisconnect",
  mattermost: "mattermostDisconnect",
  gitlab: "gitlabDisconnect",
} as const;

function connectionContext(
  operation: string,
  data: {
    organizationSlug: string;
    projectSlug?: string | undefined;
    provider?: ConnectionProvider | undefined;
  },
) {
  return {
    operation,
    component: "connections",
    organizationSlug: data.organizationSlug,
    ...(data.projectSlug === undefined ? {} : { projectSlug: data.projectSlug }),
    ...(data.provider === undefined ? {} : { provider: data.provider }),
  } as const;
}

function connectionResponseFailure(
  operation: string,
  response: Response,
  message: string,
  data: {
    organizationSlug: string;
    projectSlug?: string | undefined;
    provider?: ConnectionProvider | undefined;
  },
) {
  return respondWithFailure(
    new Error(`connection operation returned HTTP ${response.status}`),
    { ...connectionContext(operation, data), status: response.status },
    {
      fallback: message,
      authentication: message,
      forbidden: message,
      notFound: message,
      conflict: message,
      validation: message,
    },
    { status: response.status },
  );
}

function operationRequest(
  method: "GET" | "POST",
  path: string,
  scope: { organizationSlug: string; projectSlug?: string | undefined },
  connectionId?: string,
  body?: Record<string, string>,
): Request {
  const incoming = getRequest();
  const headers = new Headers(incoming.headers);
  headers.delete("content-length");
  const url = new URL(path, incoming.url);
  url.searchParams.set("organizationSlug", scope.organizationSlug);
  if (scope.projectSlug !== undefined) url.searchParams.set("projectSlug", scope.projectSlug);
  if (connectionId !== undefined) url.searchParams.set("connectionId", connectionId);
  return new Request(url, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
}
