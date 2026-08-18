import { z } from "zod";
import { MattermostPostSchema } from "./events.js";

// Endpoint shapes are recorded in ./fixtures/rest-shapes.json (Mattermost 11.10.0).

const MATTERMOST_API_TIMEOUT_MS = 10_000;
const MATTERMOST_THREAD_MAX_MESSAGES = 50;

/** `GET /api/v4/posts/{post_id}/thread` returns a map keyed by post id plus an ordering array. */
const MattermostThreadSchema = z
  .object({
    order: z.array(z.string()).default([]),
    posts: z.record(z.string(), MattermostPostSchema).default({}),
    has_next: z.boolean().optional(),
  })
  .passthrough();

const MattermostFileInfoSchema = z
  .object({
    id: z.string().min(1).max(255),
    name: z.string().min(1).max(255).optional(),
    extension: z.string().max(255).optional(),
    size: z.number().int().nonnegative().optional(),
    mime_type: z.string().max(255).optional(),
  })
  .passthrough();

const MattermostUserSchema = z
  .object({
    id: z.string().min(1).max(255),
    username: z.string().min(1).max(255),
    roles: z.string().optional(),
  })
  .passthrough();

export interface MattermostAttachmentMetadata {
  id: string;
  filename: string;
  contentType: string | null;
  size: number | null;
}

export interface MattermostThreadMessage {
  postId: string;
  createAt: number;
  createdAt: string;
  content: string;
  author: { id: string };
  attachments: MattermostAttachmentMetadata[];
}

export interface MattermostThreadReadResult {
  messages: MattermostThreadMessage[];
  complete: boolean;
}

export interface MattermostBotClient {
  sendMessage(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    rootId: string;
    content: string;
  }): Promise<void>;
  addReaction(input: {
    organizationId: string;
    teamId: string;
    postId: string;
    name: string;
  }): Promise<void>;
  removeReaction(input: {
    organizationId: string;
    teamId: string;
    postId: string;
    name: string;
  }): Promise<void>;
  readThreadMessages?(input: {
    organizationId: string;
    teamId: string;
    rootId: string;
    beforePostId: string;
  }): Promise<MattermostThreadReadResult>;
  lookupUserName?(input: {
    organizationId: string;
    teamId: string;
    userId: string;
  }): Promise<string | undefined>;
  downloadAttachment?(input: {
    organizationId: string;
    teamId: string;
    fileId: string;
  }): Promise<Response>;
}

export interface MattermostBotClientOptions {
  /** Operator-configured server origin, e.g. `https://mattermost.example.com`. */
  serverUrl: string;
  tokenForTeam(organizationId: string, teamId: string): Promise<string | undefined>;
  /** Bot user id, required by the reaction endpoints. */
  botUserIdForTeam(organizationId: string, teamId: string): Promise<string | undefined>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

/**
 * Normalizes an operator-supplied origin: trims whitespace, drops a trailing slash, and drops a
 * trailing `/api/v4` if the operator pasted the API root instead of the site URL.
 */
export function normalizeMattermostOrigin(serverUrl: string): URL {
  const trimmed = serverUrl.trim().replace(/\/+$/u, "");
  const url = new URL(/^https?:\/\//u.test(trimmed) ? trimmed : `https://${trimmed}`);
  url.pathname = url.pathname.replace(/\/api\/v4$/u, "") || "/";
  url.search = "";
  url.hash = "";
  return url;
}

/** Mattermost is frequently self-hosted on plain http inside a private network. */
export function mattermostWebsocketUrl(serverUrl: string): string {
  const origin = normalizeMattermostOrigin(serverUrl);
  const base = origin.pathname === "/" ? "" : origin.pathname.replace(/\/$/u, "");
  return `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}${base}/api/v4/websocket`;
}

export function createMattermostBotClient(
  options: MattermostBotClientOptions,
): MattermostBotClient {
  const request = options.fetch ?? fetch;
  const origin = normalizeMattermostOrigin(options.serverUrl);
  const timeout = () => AbortSignal.timeout(options.requestTimeoutMs ?? MATTERMOST_API_TIMEOUT_MS);

  const apiUrl = (path: string): URL =>
    new URL(`${origin.pathname.replace(/\/$/u, "")}/api/v4${path}`, origin);

  async function token(organizationId: string, teamId: string): Promise<string> {
    const value = await options.tokenForTeam(organizationId, teamId);
    if (value === undefined) throw new Error("Mattermost team is not connected");
    return value;
  }

  async function call(
    organizationId: string,
    teamId: string,
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<unknown> {
    const response = await request(apiUrl(path), {
      method: init.method,
      headers: {
        authorization: `Bearer ${await token(organizationId, teamId)}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: timeout(),
    });
    if (!response.ok) {
      // A bot that was never added to the channel is the overwhelmingly common cause of a refusal
      // here, and it is otherwise invisible: the mention produced an event, the run started, and
      // only the reply failed. Named as a likely cause rather than a certainty, because the
      // status alone does not prove it.
      const hint = response.status === 403 ? " (the bot may not be a member of that channel)" : "";
      throw new Error(`Mattermost API HTTP ${response.status} for ${init.method} ${path}${hint}`);
    }
    return response.status === 204 ? undefined : response.json();
  }

  async function botUserId(organizationId: string, teamId: string): Promise<string> {
    const value = await options.botUserIdForTeam(organizationId, teamId);
    if (value === undefined) throw new Error("Mattermost bot identity is unavailable");
    return value;
  }

  async function readThreadMessages(input: {
    organizationId: string;
    teamId: string;
    rootId: string;
    beforePostId: string;
  }): Promise<MattermostThreadReadResult> {
    const raw = await call(
      input.organizationId,
      input.teamId,
      `/posts/${encodeURIComponent(input.rootId)}/thread`,
      { method: "GET" },
    );
    const thread = MattermostThreadSchema.parse(raw);
    const trigger = thread.posts[input.beforePostId];
    const ordered = Object.values(thread.posts)
      .filter((post) => !post.type.startsWith("system_"))
      .filter((post) => post.id !== input.beforePostId)
      // Fall back to id comparison only if the trigger post is missing from the thread.
      .filter((post) => (trigger === undefined ? true : post.create_at < trigger.create_at))
      .sort((left, right) => left.create_at - right.create_at);

    const truncated = ordered.length > MATTERMOST_THREAD_MAX_MESSAGES;
    return {
      messages: ordered.slice(-MATTERMOST_THREAD_MAX_MESSAGES).map((post) => ({
        postId: post.id,
        createAt: post.create_at,
        createdAt: new Date(post.create_at).toISOString(),
        content: post.message,
        author: { id: post.user_id },
        attachments: (post.metadata?.files ?? []).map((file) => ({
          id: file.id,
          filename: file.name ?? file.id,
          contentType: file.mime_type ?? null,
          size: file.size ?? null,
        })),
      })),
      complete: !truncated && thread.has_next !== true,
    };
  }

  async function lookupUserName(input: {
    organizationId: string;
    teamId: string;
    userId: string;
  }): Promise<string | undefined> {
    const raw = await call(
      input.organizationId,
      input.teamId,
      `/users/${encodeURIComponent(input.userId)}`,
      { method: "GET" },
    );
    return MattermostUserSchema.parse(raw).username;
  }

  async function downloadAttachment(input: {
    organizationId: string;
    teamId: string;
    fileId: string;
  }): Promise<Response> {
    const info = MattermostFileInfoSchema.parse(
      await call(
        input.organizationId,
        input.teamId,
        `/files/${encodeURIComponent(input.fileId)}/info`,
        { method: "GET" },
      ),
    );
    if (info.id !== input.fileId) {
      throw new Error(`Mattermost file ${input.fileId} is unavailable`);
    }
    // The allowlist is the configured origin. Unlike Slack there is no fixed vendor hostname to
    // pin against, because the operator supplies the server.
    const downloadUrl = apiUrl(`/files/${encodeURIComponent(input.fileId)}`);
    if (downloadUrl.origin !== origin.origin) {
      throw new Error("Mattermost attachment URL is outside the configured server origin");
    }
    return request(downloadUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${await token(input.organizationId, input.teamId)}` },
      signal: timeout(),
    });
  }

  return {
    async sendMessage(input) {
      await call(input.organizationId, input.teamId, "/posts", {
        method: "POST",
        body: {
          channel_id: input.channelId,
          message: input.content,
          ...(input.rootId.length === 0 ? {} : { root_id: input.rootId }),
        },
      });
    },
    async addReaction(input) {
      await call(input.organizationId, input.teamId, "/reactions", {
        method: "POST",
        body: {
          user_id: await botUserId(input.organizationId, input.teamId),
          post_id: input.postId,
          emoji_name: input.name,
        },
      });
    },
    async removeReaction(input) {
      const user = await botUserId(input.organizationId, input.teamId);
      await call(
        input.organizationId,
        input.teamId,
        `/users/${encodeURIComponent(user)}/posts/${encodeURIComponent(input.postId)}/reactions/${encodeURIComponent(input.name)}`,
        { method: "DELETE" },
      );
    },
    readThreadMessages,
    lookupUserName,
    downloadAttachment,
  };
}
