import { describe, expect, it } from "vitest";
import {
  createMattermostBotClient,
  mattermostWebsocketUrl,
  normalizeMattermostOrigin,
} from "./client.js";

const ORG = "org-1";
const TEAM = "team-1";
const BOT = "bot-user-1";

const clientWith = (impl: typeof fetch) =>
  createMattermostBotClient({
    serverUrl: "https://mm.example.com",
    tokenForTeam: async () => "tok",
    botUserIdForTeam: async () => BOT,
    fetch: impl,
  });

interface RecordedRequest {
  url: URL;
  method: string | undefined;
  body: unknown;
}

/** A `fetch` the client can actually be given, so the tests need no casts to reach its calls. */
function recording(respond: (url: URL) => Response): {
  fetch: typeof fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const url = new URL(requestUrl(input));
      calls.push({
        url,
        method: init?.method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(respond(url));
    },
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

const ok = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("normalizeMattermostOrigin", () => {
  it.each([
    ["https://mm.example.com", "https://mm.example.com/"],
    ["https://mm.example.com/", "https://mm.example.com/"],
    ["https://mm.example.com///", "https://mm.example.com/"],
    ["  https://mm.example.com  ", "https://mm.example.com/"],
    ["http://mattermost.internal:8065", "http://mattermost.internal:8065/"],
    ["https://mm.example.com/api/v4", "https://mm.example.com/"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeMattermostOrigin(input).toString()).toBe(expected);
  });

  it("assumes https when no scheme is given", () => {
    expect(normalizeMattermostOrigin("mm.example.com").protocol).toBe("https:");
  });

  it("preserves a subpath deployment", () => {
    expect(normalizeMattermostOrigin("https://example.com/chat").pathname).toBe("/chat");
  });
});

describe("mattermostWebsocketUrl", () => {
  it("derives wss from https", () => {
    expect(mattermostWebsocketUrl("https://mm.example.com")).toBe(
      "wss://mm.example.com/api/v4/websocket",
    );
  });

  it("derives ws from http, which self-hosted installs commonly use", () => {
    expect(mattermostWebsocketUrl("http://mattermost.internal:8065")).toBe(
      "ws://mattermost.internal:8065/api/v4/websocket",
    );
  });

  it("handles a trailing slash", () => {
    expect(mattermostWebsocketUrl("https://mm.example.com/")).toBe(
      "wss://mm.example.com/api/v4/websocket",
    );
  });

  it("handles a subpath deployment", () => {
    expect(mattermostWebsocketUrl("https://example.com/chat")).toBe(
      "wss://example.com/chat/api/v4/websocket",
    );
  });
});

describe("sendMessage", () => {
  it("posts to the thread root when one is given", async () => {
    const server = recording(() => ok({ id: "p1" }));
    await clientWith(server.fetch).sendMessage({
      organizationId: ORG,
      teamId: TEAM,
      channelId: "c1",
      rootId: "root-1",
      content: "hello",
    });
    expect(server.calls[0]?.url.toString()).toBe("https://mm.example.com/api/v4/posts");
    expect(server.calls[0]?.body).toEqual({
      channel_id: "c1",
      message: "hello",
      root_id: "root-1",
    });
  });

  it("omits root_id entirely for a top-level post", async () => {
    const server = recording(() => ok({ id: "p1" }));
    await clientWith(server.fetch).sendMessage({
      organizationId: ORG,
      teamId: TEAM,
      channelId: "c1",
      rootId: "",
      content: "hello",
    });
    expect(server.calls[0]?.body).not.toHaveProperty("root_id");
  });

  it("throws when the team is not connected", async () => {
    const client = createMattermostBotClient({
      serverUrl: "https://mm.example.com",
      tokenForTeam: async () => undefined,
      botUserIdForTeam: async () => BOT,
      fetch: () => Promise.resolve(ok({})),
    });
    await expect(
      client.sendMessage({
        organizationId: ORG,
        teamId: TEAM,
        channelId: "c1",
        rootId: "",
        content: "x",
      }),
    ).rejects.toThrow(/not connected/u);
  });

  it("surfaces a non-2xx response", async () => {
    await expect(
      clientWith(recording(() => new Response("nope", { status: 403 })).fetch).sendMessage({
        organizationId: ORG,
        teamId: TEAM,
        channelId: "c1",
        rootId: "",
        content: "x",
      }),
    ).rejects.toThrow(/HTTP 403/u);
  });
});

describe("reactions", () => {
  it("adds a reaction with the bot user id", async () => {
    const server = recording(() => ok({ emoji_name: "eyes" }));
    await clientWith(server.fetch).addReaction({
      organizationId: ORG,
      teamId: TEAM,
      postId: "p1",
      name: "eyes",
    });
    expect(server.calls[0]?.url.pathname).toBe("/api/v4/reactions");
    expect(server.calls[0]?.body).toEqual({
      user_id: BOT,
      post_id: "p1",
      emoji_name: "eyes",
    });
  });

  it("removes a reaction via the per-user path", async () => {
    const server = recording(() => ok({ status: "OK" }));
    await clientWith(server.fetch).removeReaction({
      organizationId: ORG,
      teamId: TEAM,
      postId: "p1",
      name: "eyes",
    });
    expect(server.calls[0]?.url.pathname).toBe(`/api/v4/users/${BOT}/posts/p1/reactions/eyes`);
    expect(server.calls[0]?.method).toBe("DELETE");
  });
});

describe("readThreadMessages", () => {
  const thread = (posts: Record<string, unknown>) => ok({ order: Object.keys(posts), posts });
  const post = (id: string, createAt: number, extra: Record<string, unknown> = {}) => ({
    id,
    create_at: createAt,
    user_id: "u1",
    channel_id: "c1",
    root_id: "root",
    message: `m-${id}`,
    type: "",
    ...extra,
  });

  it("returns messages before the trigger post, oldest first", async () => {
    const server = recording(() =>
      thread({ a: post("a", 100), b: post("b", 200), trigger: post("trigger", 300) }),
    );
    const result = await clientWith(server.fetch).readThreadMessages!({
      organizationId: ORG,
      teamId: TEAM,
      rootId: "root",
      beforePostId: "trigger",
    });
    expect(result.messages.map((m) => m.postId)).toEqual(["a", "b"]);
    expect(result.complete).toBe(true);
  });

  it("excludes the trigger post itself", async () => {
    const server = recording(() => thread({ a: post("a", 100), trigger: post("trigger", 300) }));
    const result = await clientWith(server.fetch).readThreadMessages!({
      organizationId: ORG,
      teamId: TEAM,
      rootId: "root",
      beforePostId: "trigger",
    });
    expect(result.messages.map((m) => m.postId)).not.toContain("trigger");
  });

  it("drops system posts", async () => {
    const server = recording(() =>
      thread({
        a: post("a", 100),
        j: post("j", 150, { type: "system_join_channel" }),
        trigger: post("trigger", 300),
      }),
    );
    const result = await clientWith(server.fetch).readThreadMessages!({
      organizationId: ORG,
      teamId: TEAM,
      rootId: "root",
      beforePostId: "trigger",
    });
    expect(result.messages.map((m) => m.postId)).toEqual(["a"]);
  });

  it("reports incomplete when the thread exceeds the cap", async () => {
    const posts: Record<string, unknown> = { trigger: post("trigger", 100_000) };
    for (let i = 0; i < 60; i += 1) posts[`p${i}`] = post(`p${i}`, i);
    const result = await clientWith(recording(() => thread(posts)).fetch).readThreadMessages!({
      organizationId: ORG,
      teamId: TEAM,
      rootId: "root",
      beforePostId: "trigger",
    });
    expect(result.messages).toHaveLength(50);
    expect(result.complete).toBe(false);
    // Keeps the most recent context, not the oldest.
    expect(result.messages.at(-1)?.postId).toBe("p59");
  });

  it("carries attachment metadata from post.metadata.files", async () => {
    const server = recording(() =>
      thread({
        a: post("a", 100, {
          metadata: { files: [{ id: "f1", name: "n.txt", mime_type: "text/plain", size: 4 }] },
        }),
        trigger: post("trigger", 300),
      }),
    );
    const result = await clientWith(server.fetch).readThreadMessages!({
      organizationId: ORG,
      teamId: TEAM,
      rootId: "root",
      beforePostId: "trigger",
    });
    expect(result.messages[0]?.attachments[0]).toEqual({
      id: "f1",
      filename: "n.txt",
      contentType: "text/plain",
      size: 4,
    });
  });
});

describe("downloadAttachment", () => {
  it("fetches info then the file body", async () => {
    const server = recording((url) =>
      url.toString().endsWith("/info")
        ? ok({ id: "f1", name: "n.txt" })
        : new Response("bytes", { status: 200 }),
    );
    const response = await clientWith(server.fetch).downloadAttachment!({
      organizationId: ORG,
      teamId: TEAM,
      fileId: "f1",
    });
    expect(await response.text()).toBe("bytes");
    expect(server.calls).toHaveLength(2);
  });

  it("rejects when the server returns a different file id", async () => {
    await expect(
      clientWith(recording(() => ok({ id: "other" })).fetch).downloadAttachment!({
        organizationId: ORG,
        teamId: TEAM,
        fileId: "f1",
      }),
    ).rejects.toThrow(/unavailable/u);
  });

  it("only ever requests the configured origin", async () => {
    const server = recording((url) =>
      url.toString().endsWith("/info") ? ok({ id: "f1" }) : new Response("bytes", { status: 200 }),
    );
    await clientWith(server.fetch).downloadAttachment!({
      organizationId: ORG,
      teamId: TEAM,
      fileId: "f1",
    });
    expect(new Set(server.calls.map((call) => call.url.origin))).toEqual(
      new Set(["https://mm.example.com"]),
    );
  });
});
