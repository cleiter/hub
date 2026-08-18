import { z } from "zod";
import { afterAll, describe, expect, it } from "vitest";
import { createMattermostBotClient, mattermostWebsocketUrl } from "./client.js";
import { isMattermostTriggerCandidate, normalizeMattermostEvent } from "./events.js";
import { mentionsBot } from "./match.js";

/**
 * Live contract test against a real Mattermost server.
 *
 * Deliberately NOT part of the default CI job: CI provisions only postgres, and a Mattermost
 * container needs its own database, an admin bootstrap, and a slow boot. The committed
 * fixtures in ./fixtures are what guard the schemas on every PR; this test is how those
 * fixtures get re-verified when bumping the pinned server version.
 *
 * To run it, start a server and export:
 *   RUN_MATTERMOST_REAL_CONTRACT=1
 *   MATTERMOST_TEST_URL, MATTERMOST_TEST_BOT_TOKEN, MATTERMOST_TEST_ADMIN_TOKEN,
 *   MATTERMOST_TEST_TEAM_ID, MATTERMOST_TEST_CHANNEL_ID, MATTERMOST_TEST_BOT_USER_ID,
 *   MATTERMOST_TEST_BOT_USERNAME
 */
const SHOULD_RUN = process.env["RUN_MATTERMOST_REAL_CONTRACT"] === "1";

const IdSchema = z.looseObject({ id: z.string() });
const ChannelSchema = z.looseObject({ id: z.string(), team_id: z.string() });
const UploadSchema = z.looseObject({ file_infos: z.array(z.looseObject({ id: z.string() })) });
const FrameSchema = z.looseObject({
  event: z.string().optional(),
  broadcast: z.looseObject({ channel_id: z.string().optional() }).optional(),
});

const env = (name: string): string => process.env[name] ?? "";
const URL_ = env("MATTERMOST_TEST_URL");
const BOT_TOKEN = env("MATTERMOST_TEST_BOT_TOKEN");
const ADMIN_TOKEN = env("MATTERMOST_TEST_ADMIN_TOKEN");
const TEAM_ID = env("MATTERMOST_TEST_TEAM_ID");
const CHANNEL_ID = env("MATTERMOST_TEST_CHANNEL_ID");
const BOT_USER_ID = env("MATTERMOST_TEST_BOT_USER_ID");
const BOT_USERNAME = env("MATTERMOST_TEST_BOT_USERNAME") || "paseobot";

const client = SHOULD_RUN
  ? createMattermostBotClient({
      serverUrl: URL_,
      tokenForTeam: async () => BOT_TOKEN,
      botUserIdForTeam: async () => BOT_USER_ID,
    })
  : undefined;

const adminPost = async (body: Record<string, unknown>): Promise<{ id: string }> => {
  const response = await fetch(`${URL_}/api/v4/posts`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`seed post failed: HTTP ${response.status}`);
  return IdSchema.parse(await response.json());
};

const sockets: WebSocket[] = [];
afterAll(() => {
  for (const socket of sockets) socket.close();
});

/** Opens an authenticated gateway connection and collects frames until `settle` elapses. */
async function collectFrames(action: () => Promise<void>, settleMs = 1_500): Promise<unknown[]> {
  const frames: unknown[] = [];
  const socket = new WebSocket(mattermostWebsocketUrl(URL_));
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hello never arrived")), 10_000);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          seq: 1,
          action: "authentication_challenge",
          data: { token: BOT_TOKEN },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      const frame: unknown = JSON.parse(String(event.data));
      frames.push(frame);
      if (FrameSchema.parse(frame).event === "hello") {
        clearTimeout(timer);
        resolve();
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("gateway connection failed"));
    });
  });
  await action();
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  socket.close();
  return frames;
}

describe.skipIf(!SHOULD_RUN)("mattermost live contract", () => {
  it("authenticates over the websocket and receives hello", async () => {
    const frames = await collectFrames(async () => {}, 200);
    expect(frames.some((frame) => FrameSchema.parse(frame).event === "hello")).toBe(true);
  });

  it("delivers a posted event whose shape still matches the committed schema", async () => {
    const frames = await collectFrames(async () => {
      await adminPost({ channel_id: CHANNEL_ID, message: `@${BOT_USERNAME} contract check` });
    });
    const posted = frames.filter((f) => isMattermostTriggerCandidate(f, BOT_USER_ID));
    expect(posted.length).toBeGreaterThan(0);

    const event = normalizeMattermostEvent(posted[0], BOT_USER_ID);
    expect(event).toBeDefined();
    expect(event?.teamId).toBe(TEAM_ID);
    expect(event?.channelId).toBe(CHANNEL_ID);
    expect(event?.channelType).toBe("O");
    expect(event?.content).toContain(`@${BOT_USERNAME}`);
    expect(mentionsBot(event!.content, BOT_USERNAME)).toBe(true);
    // sender_name must still arrive, otherwise every trigger costs an extra user lookup.
    expect(event?.author.username).toBeDefined();
  });

  it("still reports the empty string for team_id on direct messages", async () => {
    const channel = await fetch(`${URL_}/api/v4/channels/direct`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify([env("MATTERMOST_TEST_ADMIN_USER_ID"), BOT_USER_ID]),
    }).then(async (response) => ChannelSchema.parse(await response.json()));
    expect(channel.team_id).toBe("");

    const frames = await collectFrames(async () => {
      await adminPost({ channel_id: channel.id, message: "direct message contract check" });
    });
    const dm = frames.find((raw) => {
      const frame = FrameSchema.parse(raw);
      return frame.event === "posted" && frame.broadcast?.channel_id === channel.id;
    });
    expect(dm).toBeDefined();
    // The whole reason DMs are out of scope: no team to route to.
    expect(isMattermostTriggerCandidate(dm, BOT_USER_ID)).toBe(false);
    expect(normalizeMattermostEvent(dm, BOT_USER_ID)).toBeUndefined();
  });

  it("still puts the bot in data.mentions for @channel, so text matching stays required", async () => {
    const frames = await collectFrames(async () => {
      await adminPost({ channel_id: CHANNEL_ID, message: "@channel broadcast contract check" });
    });
    const broadcast = frames.filter((f) => isMattermostTriggerCandidate(f, BOT_USER_ID));
    expect(broadcast.length).toBeGreaterThan(0);
    const event = normalizeMattermostEvent(broadcast[0], BOT_USER_ID);
    expect(event?.mentionedUserIds).toContain(BOT_USER_ID);
    // ...and yet it must not count as addressing the bot.
    expect(mentionsBot(event!.content, BOT_USERNAME)).toBe(false);
  });

  it("adds and removes a reaction", async () => {
    const post = await adminPost({ channel_id: CHANNEL_ID, message: "reaction contract check" });
    await expect(
      client!.addReaction({
        organizationId: "org",
        teamId: TEAM_ID,
        postId: post.id,
        name: "eyes",
      }),
    ).resolves.toBeUndefined();
    await expect(
      client!.removeReaction({
        organizationId: "org",
        teamId: TEAM_ID,
        postId: post.id,
        name: "eyes",
      }),
    ).resolves.toBeUndefined();
  });

  it("posts a threaded reply", async () => {
    const root = await adminPost({ channel_id: CHANNEL_ID, message: "thread root" });
    await expect(
      client!.sendMessage({
        organizationId: "org",
        teamId: TEAM_ID,
        channelId: CHANNEL_ID,
        rootId: root.id,
        content: "threaded reply contract check",
      }),
    ).resolves.toBeUndefined();

    const thread = await client!.readThreadMessages!({
      organizationId: "org",
      teamId: TEAM_ID,
      rootId: root.id,
      beforePostId: "does-not-exist",
    });
    expect(thread.messages.map((m) => m.content)).toContain("threaded reply contract check");
  });

  it("hydrates thread history in chronological order", async () => {
    const root = await adminPost({ channel_id: CHANNEL_ID, message: "history root" });
    await adminPost({ channel_id: CHANNEL_ID, message: "first", root_id: root.id });
    await adminPost({ channel_id: CHANNEL_ID, message: "second", root_id: root.id });
    const trigger = await adminPost({
      channel_id: CHANNEL_ID,
      message: `@${BOT_USERNAME} summarize`,
      root_id: root.id,
    });

    const thread = await client!.readThreadMessages!({
      organizationId: "org",
      teamId: TEAM_ID,
      rootId: root.id,
      beforePostId: trigger.id,
    });
    const contents = thread.messages.map((m) => m.content);
    expect(contents).toEqual(["history root", "first", "second"]);
    expect(contents).not.toContain(`@${BOT_USERNAME} summarize`);
    expect(thread.complete).toBe(true);
  });

  it("looks up a username", async () => {
    await expect(
      client!.lookupUserName!({ organizationId: "org", teamId: TEAM_ID, userId: BOT_USER_ID }),
    ).resolves.toBe(BOT_USERNAME);
  });

  it("downloads an attachment through the configured origin", async () => {
    const form = new FormData();
    form.append("files", new Blob(["contract payload"], { type: "text/plain" }), "contract.txt");
    form.append("channel_id", CHANNEL_ID);
    const upload = UploadSchema.parse(
      await fetch(`${URL_}/api/v4/files`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: form,
      }).then((r) => r.json()),
    );
    const fileId = upload.file_infos[0]!.id;
    await adminPost({
      channel_id: CHANNEL_ID,
      message: `@${BOT_USERNAME} see attachment`,
      file_ids: [fileId],
    });

    const response = await client!.downloadAttachment!({
      organizationId: "org",
      teamId: TEAM_ID,
      fileId,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("contract payload");
  });

  it("refuses to post into a channel the bot is not a member of", async () => {
    const channel = IdSchema.parse(
      await fetch(`${URL_}/api/v4/channels`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          team_id: TEAM_ID,
          name: `contract-nobot-${Date.now()}`,
          display_name: "No Bot",
          type: "O",
        }),
      }).then((r) => r.json()),
    );

    await expect(
      client!.sendMessage({
        organizationId: "org",
        teamId: TEAM_ID,
        channelId: channel.id,
        rootId: "",
        content: "should be refused",
      }),
    ).rejects.toThrow(/HTTP 403/u);
  });
});
