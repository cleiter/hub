import { z } from "zod";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isMattermostTriggerCandidate, normalizeMattermostEvent } from "./events.js";

// These tests run against frames recorded from a real Mattermost 11.10.0 server. If a schema
// here drifts from reality, these fail — which is the entire point of recording them.
const PostedFrameSchema = z.looseObject({ data: z.looseObject({ post: z.string() }) });
const PostSchema = z.record(z.string(), z.unknown());

/** Reads a recorded `posted` frame in a shape the tests can edit without casting. */
const postedFixture = (name: string) => {
  const frame = PostedFrameSchema.parse(fixture(name));
  return { frame, post: PostSchema.parse(JSON.parse(frame.data.post)) };
};

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const BOT_USER_ID = "r8busjtmztnxdro8a1bam8j5fh";
const ADMIN_USER_ID = "jnrisb1fmfbafr3dmu8nufts9r";
const TEAM_ID = "n647fxr7atdepji7rcpw4qtdia";

describe("normalizeMattermostEvent", () => {
  it("normalizes a mention in a public channel", () => {
    const event = normalizeMattermostEvent(fixture("posted-public-channel"), BOT_USER_ID);
    expect(event).toBeDefined();
    expect(event?.teamId).toBe(TEAM_ID);
    expect(event?.channelType).toBe("O");
    expect(event?.content).toBe("@paseobot please review the deploy");
    expect(event?.author.id).toBe(ADMIN_USER_ID);
    // sender_name arrives as "@admin"; the leading @ must be stripped so from_users can match it.
    expect(event?.author.username).toBe("admin");
    expect(event?.mentionedUserIds).toContain(BOT_USER_ID);
  });

  it("normalizes a mention in a private channel", () => {
    const event = normalizeMattermostEvent(fixture("posted-private-channel"), BOT_USER_ID);
    expect(event?.channelType).toBe("P");
    expect(event?.teamId).toBe(TEAM_ID);
  });

  it("reports a root post as having no thread root", () => {
    // Mattermost sends root_id as "" for root posts, not null.
    const event = normalizeMattermostEvent(fixture("posted-public-channel"), BOT_USER_ID);
    expect(event?.rootId).toBeNull();
  });

  it("carries the thread root for a reply", () => {
    const event = normalizeMattermostEvent(fixture("posted-thread-reply"), BOT_USER_ID);
    expect(event?.rootId).toBe("gya6fp1krpnzurby4ko68edsiw");
    expect(event?.rootId).not.toBe(event?.postId);
  });

  it("drops direct messages, which carry no team", () => {
    expect(normalizeMattermostEvent(fixture("posted-direct-message"), BOT_USER_ID)).toBeUndefined();
  });

  it("extracts attachment metadata from the event without a further request", () => {
    const event = normalizeMattermostEvent(fixture("posted-with-attachment"), BOT_USER_ID);
    expect(event?.attachments).toHaveLength(1);
    expect(event?.attachments[0]).toMatchObject({
      filename: "notes.txt",
      contentType: "text/plain; charset=utf-8",
      size: 24,
    });
  });

  it("converts create_at epoch milliseconds to an ISO timestamp", () => {
    const event = normalizeMattermostEvent(fixture("posted-public-channel"), BOT_USER_ID);
    expect(event?.createdAt).toBe(new Date(event!.createAt).toISOString());
    expect(event?.createdAt.startsWith("20")).toBe(true);
  });

  it("ignores the bot's own posts", () => {
    const { frame, post } = postedFixture("posted-public-channel");
    const own = {
      ...frame,
      data: { ...frame.data, post: JSON.stringify({ ...post, user_id: BOT_USER_ID }) },
    };
    expect(normalizeMattermostEvent(own, BOT_USER_ID)).toBeUndefined();
  });

  it("ignores system posts such as joins and header changes", () => {
    const { frame, post } = postedFixture("posted-public-channel");
    const system = {
      ...frame,
      data: { ...frame.data, post: JSON.stringify({ ...post, type: "system_join_channel" }) },
    };
    expect(normalizeMattermostEvent(system, BOT_USER_ID)).toBeUndefined();
  });

  it("returns undefined rather than throwing on malformed input", () => {
    expect(
      normalizeMattermostEvent({ event: "posted", data: { post: "{not json" } }, BOT_USER_ID),
    ).toBeUndefined();
    expect(normalizeMattermostEvent({ event: "hello" }, BOT_USER_ID)).toBeUndefined();
    expect(normalizeMattermostEvent(null, BOT_USER_ID)).toBeUndefined();
    expect(normalizeMattermostEvent({}, BOT_USER_ID)).toBeUndefined();
  });
});

describe("isMattermostTriggerCandidate", () => {
  it("accepts a real mention frame", () => {
    expect(isMattermostTriggerCandidate(fixture("posted-public-channel"), BOT_USER_ID)).toBe(true);
  });

  it("rejects ordinary chatter, which carries no mentions key at all", () => {
    expect(isMattermostTriggerCandidate(fixture("posted-no-mention"), BOT_USER_ID)).toBe(false);
  });

  it("rejects direct messages before any parsing", () => {
    expect(isMattermostTriggerCandidate(fixture("posted-direct-message"), BOT_USER_ID)).toBe(false);
  });

  it("rejects non-posted events", () => {
    expect(isMattermostTriggerCandidate(fixture("hello"), BOT_USER_ID)).toBe(false);
  });

  it("rejects a mention of a different user", () => {
    expect(isMattermostTriggerCandidate(fixture("posted-public-channel"), "someone-else")).toBe(
      false,
    );
  });

  it("never parses the payload it rejects", () => {
    // The cheap check must not touch data.post, which is why it can run on every frame.
    const poisoned = {
      event: "posted",
      data: {
        team_id: TEAM_ID,
        post: {
          get length() {
            throw new Error("data.post must not be read during the candidate check");
          },
        },
      },
    };
    expect(() => isMattermostTriggerCandidate(poisoned, BOT_USER_ID)).not.toThrow();
    expect(isMattermostTriggerCandidate(poisoned, BOT_USER_ID)).toBe(false);
  });
});
