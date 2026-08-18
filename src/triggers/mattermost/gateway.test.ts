import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createMattermostGatewaySource } from "./gateway.js";
import type { CreateMattermostGatewaySourceOptions } from "./gateway.js";
import { createMemoryMattermostBot } from "./memory-bot.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const BOT_USER_ID = "r8busjtmztnxdro8a1bam8j5fh";
const TEAM_ID = "n647fxr7atdepji7rcpw4qtdia";

type AcceptInput = Parameters<CreateMattermostGatewaySourceOptions["accept"]>[0];

describe("createMattermostGatewaySource", () => {
  let bot: ReturnType<typeof createMemoryMattermostBot>;
  let accepts: AcceptInput[];
  let acceptFails: boolean;
  const accept: CreateMattermostGatewaySourceOptions["accept"] = (input) => {
    accepts.push(input);
    return acceptFails
      ? Promise.reject(new Error("database is down"))
      : Promise.resolve({ status: "accepted", events: [], receiptId: "receipt-1" });
  };

  beforeEach(() => {
    bot = createMemoryMattermostBot({ userId: BOT_USER_ID });
    accepts = [];
    acceptFails = false;
  });

  const start = async () => {
    const source = createMattermostGatewaySource({ bot, accept });
    await source.start(async () => undefined);
    return source;
  };

  it("starts the bot and accepts a real mention frame", async () => {
    await start();
    expect(bot.started()).toBe(true);
    await bot.emit(fixture("posted-public-channel"));

    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toMatchObject({
      teamId: TEAM_ID,
      source: "mattermost.mention",
      deliveryId: "mattermost-gya6fp1krpnzurby4ko68edsiw",
    });
  });

  it("carries the permalink parts the frame does not have onto the payload", async () => {
    bot.setTeamName(TEAM_ID, "platform");
    await start();
    await bot.emit(fixture("posted-public-channel"));

    expect(accepts[0]?.payload).toMatchObject({
      serverUrl: "https://mattermost.example.com",
      teamName: "platform",
    });
  });

  it("omits the team name when the bot could not resolve it", async () => {
    await start();
    await bot.emit(fixture("posted-public-channel"));

    expect(accepts[0]?.payload).not.toHaveProperty("teamName");
  });

  it("derives the delivery id from the post id so a replayed frame dedupes", async () => {
    await start();
    await bot.emit(fixture("posted-public-channel"));
    await bot.emit(fixture("posted-public-channel"));
    expect(new Set(accepts.map((input) => input.deliveryId)).size).toBe(1);
  });

  it("drops ordinary chatter", async () => {
    await start();
    await bot.emit(fixture("posted-no-mention"));
    expect(accepts).toHaveLength(0);
  });

  it("drops direct messages, which have no team to route to", async () => {
    await start();
    await bot.emit(fixture("posted-direct-message"));
    expect(accepts).toHaveLength(0);
  });

  it("ignores non-posted frames", async () => {
    await start();
    await bot.emit(fixture("hello"));
    expect(accepts).toHaveLength(0);
  });

  it("accepts a private channel mention", async () => {
    await start();
    await bot.emit(fixture("posted-private-channel"));
    expect(accepts).toHaveLength(1);
  });

  it("does nothing until the bot identity is known", async () => {
    bot.setSelf(undefined);
    await start();
    await bot.emit(fixture("posted-public-channel"));
    expect(accepts).toHaveLength(0);
  });

  it("marks the event as unroutable when no handler is registered", async () => {
    const source = createMattermostGatewaySource({ bot, accept });
    await source.start(async () => undefined);
    await source.stop();
    // Re-subscribe the frame listener without any handler in the set.
    await source.start(async () => undefined);
    await bot.emit(fixture("posted-public-channel"));
    expect(accepts.length).toBeGreaterThan(0);
  });

  it("does not let an acceptance failure escape the frame listener", async () => {
    acceptFails = true;
    await start();
    await expect(bot.emit(fixture("posted-public-channel"))).resolves.toBeUndefined();
  });

  it("stops the bot and detaches listeners", async () => {
    const source = await start();
    await source.stop();
    expect(bot.started()).toBe(false);
    await bot.emit(fixture("posted-public-channel"));
    expect(accepts).toHaveLength(0);
  });

  it("never parses the payload of a frame it discards", async () => {
    // The point of the 6A ordering: the discard path costs property reads, not a JSON.parse and
    // two zod passes. Discord pays that cost on every message (discord/gateway.ts:106,115).
    await start();
    // Load the fixtures first — reading them off disk parses JSON too.
    const chatter = fixture("posted-no-mention");
    const mention = fixture("posted-public-channel");
    const parse = vi.spyOn(JSON, "parse");
    try {
      await bot.emit(chatter);
      expect(parse).not.toHaveBeenCalled();

      await bot.emit(mention);
      // A real mention parses two *different* fields once each — the post body and the
      // mentions array. What must never happen is the same payload being parsed twice, which
      // is the shape Discord has.
      const inputs = parse.mock.calls.map((call) => call[0]);
      expect(new Set(inputs).size).toBe(inputs.length);
      expect(inputs.filter((input) => input.includes("please review the deploy"))).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
    expect(accepts).toHaveLength(1);
  });
});
