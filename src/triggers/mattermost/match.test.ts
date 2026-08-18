import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeMattermostEvent, type NormalizedMattermostMentionEvent } from "./events.js";
import { matchMattermostTriggers, mentionsBot, readMattermostPromptBody } from "./match.js";
import type { CompiledTriggerConfig } from "../../config/index.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const BOT_USER_ID = "r8busjtmztnxdro8a1bam8j5fh";
const BOT_USERNAME = "paseobot";
const ADMIN_USER_ID = "jnrisb1fmfbafr3dmu8nufts9r";
const TEAM_ID = "n647fxr7atdepji7rcpw4qtdia";

const baseEvent = (): NormalizedMattermostMentionEvent => {
  const event = normalizeMattermostEvent(fixture("posted-public-channel"), BOT_USER_ID);
  if (event === undefined) throw new Error("fixture failed to normalize");
  return event;
};

const withContent = (content: string): NormalizedMattermostMentionEvent => ({
  ...baseEvent(),
  content,
});

type Filters = NonNullable<CompiledTriggerConfig["filters"]>;

const config = (filters: Filters) => ({
  triggers: [{ name: "review", on: "mattermost.mention", filters }],
});

const match = (event: NormalizedMattermostMentionEvent, filters: Filters) =>
  matchMattermostTriggers(config(filters), event, BOT_USER_ID, BOT_USERNAME);

describe("mentionsBot", () => {
  it("matches an explicit mention", () => {
    expect(mentionsBot("@paseobot please review", BOT_USERNAME)).toBe(true);
    expect(mentionsBot("hey @paseobot", BOT_USERNAME)).toBe(true);
    expect(mentionsBot("ping @paseobot!", BOT_USERNAME)).toBe(true);
  });

  it("does not match a longer username with the same prefix", () => {
    expect(mentionsBot("@paseobotter is someone else", BOT_USERNAME)).toBe(false);
  });

  it("does not match an email address containing the name", () => {
    expect(mentionsBot("mail paseobot@example.com", BOT_USERNAME)).toBe(false);
  });

  it("does not match a bare name with no @", () => {
    expect(mentionsBot("paseobot should look at this", BOT_USERNAME)).toBe(false);
  });

  it("finds a later mention when an earlier candidate fails the boundary test", () => {
    expect(mentionsBot("@paseobotter and also @paseobot", BOT_USERNAME)).toBe(true);
  });
});

describe("broadcast mentions", () => {
  // Recorded finding: Mattermost puts the bot into data.mentions for @channel/@all/@here.
  // Trusting mentionedUserIds alone would fire the agent on every announcement.
  it.each(["@channel deploy is going out", "@all heads up everyone", "@here quick question"])(
    "does not match %j even though the bot is in mentionedUserIds",
    (content) => {
      const event = { ...withContent(content), mentionedUserIds: [BOT_USER_ID] };
      expect(event.mentionedUserIds).toContain(BOT_USER_ID);
      expect(match(event, { from_users: [ADMIN_USER_ID] })).toHaveLength(0);
    },
  );
});

describe("matchMattermostTriggers", () => {
  it("matches a mention from an allowed user by id", () => {
    expect(match(baseEvent(), { from_users: [ADMIN_USER_ID] })).toHaveLength(1);
  });

  it("matches a mention from an allowed user by username", () => {
    // Preserves the ID-or-username allowlist behaviour Slack gained in #49.
    expect(match(baseEvent(), { from_users: ["admin"] })).toHaveLength(1);
  });

  it("rejects a user who is not on the allowlist", () => {
    expect(match(baseEvent(), { from_users: ["someone-else"] })).toHaveLength(0);
  });

  it("requires from_users to be set at all", () => {
    expect(match(baseEvent(), {})).toHaveLength(0);
  });

  it("rejects a post that does not mention the bot", () => {
    expect(match(withContent("unrelated chatter"), { from_users: [ADMIN_USER_ID] })).toHaveLength(
      0,
    );
  });

  it("ignores the bot's own messages", () => {
    const own = { ...baseEvent(), author: { id: BOT_USER_ID, username: BOT_USERNAME } };
    expect(match(own, { from_users: [BOT_USER_ID] })).toHaveLength(0);
  });

  it("applies the team filter", () => {
    expect(match(baseEvent(), { from_users: [ADMIN_USER_ID], team: TEAM_ID })).toHaveLength(1);
    expect(match(baseEvent(), { from_users: [ADMIN_USER_ID], team: "other" })).toHaveLength(0);
  });

  it("applies the channels filter", () => {
    const event = baseEvent();
    expect(match(event, { from_users: [ADMIN_USER_ID], channels: [event.channelId] })).toHaveLength(
      1,
    );
    expect(match(event, { from_users: [ADMIN_USER_ID], channels: ["nope"] })).toHaveLength(0);
  });

  it("applies the connection filter", () => {
    const cfg = config({ from_users: [ADMIN_USER_ID], connectionId: "conn-1" });
    expect(
      matchMattermostTriggers(cfg, baseEvent(), BOT_USER_ID, BOT_USERNAME, "conn-1"),
    ).toHaveLength(1);
    expect(
      matchMattermostTriggers(cfg, baseEvent(), BOT_USER_ID, BOT_USERNAME, "conn-2"),
    ).toHaveLength(0);
  });

  it("ignores triggers bound to a different event name", () => {
    const cfg = { triggers: [{ name: "x", on: "slack.mention", filters: {} }] };
    expect(matchMattermostTriggers(cfg, baseEvent(), BOT_USER_ID, BOT_USERNAME)).toHaveLength(0);
  });

  describe("pattern prefix", () => {
    it("matches a pattern at the start of the body", () => {
      const event = withContent("@paseobot review the deploy");
      expect(match(event, { from_users: [ADMIN_USER_ID], pattern: "review" })).toHaveLength(1);
    });

    it("requires a word boundary after the pattern", () => {
      const event = withContent("@paseobot reviewer please");
      expect(match(event, { from_users: [ADMIN_USER_ID], pattern: "review" })).toHaveLength(0);
    });

    it("rejects a pattern that is not at the start", () => {
      const event = withContent("@paseobot please review");
      expect(match(event, { from_users: [ADMIN_USER_ID], pattern: "review" })).toHaveLength(0);
    });
  });
});

describe("readMattermostPromptBody", () => {
  it("strips the mention and leading whitespace", () => {
    expect(readMattermostPromptBody(withContent("@paseobot   do the thing"), BOT_USERNAME)).toBe(
      "do the thing",
    );
  });

  it("returns the whole message when the bot is not mentioned", () => {
    expect(readMattermostPromptBody(withContent("no mention"), BOT_USERNAME)).toBe("no mention");
  });

  it("keeps text preceding the mention out of the body", () => {
    expect(readMattermostPromptBody(withContent("hey @paseobot ship it"), BOT_USERNAME)).toBe(
      "ship it",
    );
  });
});
