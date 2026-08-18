import { afterEach, describe, expect, it, vi } from "vitest";
import { createMattermostBot } from "./bot.js";

/**
 * Minimal stand-in for the browser WebSocket the vendor client constructs. It exposes only what
 * `@mattermost/client`'s WebSocketClient actually touches: the four handler slots, `readyState`,
 * `send`, and `close`.
 */
class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  /** Drives the vendor client the way a real server would. */
  open(): void {
    this.onopen?.();
  }
  /** Server-sent event stream sequence; the vendor client reconnects if it sees a gap. */
  private seq = 0;
  message(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ ...frame, seq: this.seq }) });
    this.seq += 1;
  }
  /** Skips a sequence number, which is how the client detects a missed event. */
  messageOutOfOrder(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ ...frame, seq: this.seq + 5 }) });
  }
  drop(code = 1006): void {
    this.onclose?.({ code });
  }
  /** A transport error event, which carries a `message` the way a browser's ErrorEvent does. */
  fail(message: string): void {
    const event = new Event("error");
    Object.assign(event, { message });
    this.onerror?.(event);
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

const SELF = { id: "r8busjtmztnxdro8a1bam8j5fh", username: "paseobot" };
const TEAMS = [{ id: "n647fxr7atdepji7rcpw4qtdia", name: "platform" }];

function harness(overrides: { respond?: typeof fetch } = {}): {
  bot: ReturnType<typeof createMattermostBot>;
  sockets: FakeSocket[];
  requests: URL[];
} {
  const sockets: FakeSocket[] = [];
  const requests: URL[] = [];
  const respond: typeof fetch =
    overrides.respond ??
    ((input) => {
      const url = new URL(requestUrl(input));
      requests.push(url);
      const body = url.pathname.endsWith("/teams") ? TEAMS : SELF;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
  const bot = createMattermostBot({
    serverUrl: "https://chat.example.com",
    botToken: "bot-token",
    fetch: respond,
    newWebSocketFn: (url: string) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- focused socket double
      return socket as unknown as WebSocket;
    },
    now: () => new Date("2026-08-17T12:00:00.000Z"),
  });
  return { bot, sockets, requests };
}

describe("createMattermostBot", () => {
  let running: ReturnType<typeof createMattermostBot> | undefined;

  afterEach(async () => {
    await running?.stop();
    running = undefined;
    vi.useRealTimers();
  });

  it("resolves its own identity from /users/me before opening the socket", async () => {
    const { bot, sockets, requests } = harness();
    running = bot;
    await bot.start();

    expect(requests[0]?.pathname).toBe("/api/v4/users/me");
    expect(bot.getSelfUserId()).toBe(SELF.id);
    expect(bot.getSelfUsername()).toBe("paseobot");
    expect(sockets).toHaveLength(1);
  });

  it("resolves the team slugs a permalink needs, which the websocket frames never carry", async () => {
    const { bot, requests } = harness();
    running = bot;
    await bot.start();

    expect(requests[1]?.pathname).toBe("/api/v4/users/me/teams");
    expect(bot.getTeamName("n647fxr7atdepji7rcpw4qtdia")).toBe("platform");
    expect(bot.getTeamName("unknown-team")).toBeUndefined();
    expect(bot.serverOrigin()).toBe("https://chat.example.com");
  });

  it("still connects when the team lookup fails, because a permalink is not worth a dead bot", async () => {
    const { bot, sockets } = harness({
      respond: (input) =>
        Promise.resolve(
          new URL(requestUrl(input)).pathname.endsWith("/teams")
            ? new Response("nope", { status: 500 })
            : new Response(JSON.stringify(SELF), { status: 200 }),
        ),
    });
    running = bot;
    await bot.start();

    expect(sockets).toHaveLength(1);
    expect(bot.getTeamName("n647fxr7atdepji7rcpw4qtdia")).toBeUndefined();
  });

  it("connects to the wss endpoint derived from the configured origin", async () => {
    const { bot, sockets } = harness();
    running = bot;
    await bot.start();

    expect(sockets[0]?.url.startsWith("wss://chat.example.com/api/v4/websocket")).toBe(true);
  });

  it("surfaces a revoked token instead of retrying silently", async () => {
    const { bot, sockets } = harness({
      respond: () => Promise.resolve(new Response("", { status: 401 })),
    });
    running = bot;

    await expect(bot.start()).rejects.toThrow(/HTTP 401/u);
    // Nothing was opened, so there is no socket retrying against a dead credential.
    expect(sockets).toHaveLength(0);
    expect(bot.getSelfUserId()).toBeUndefined();
  });

  it("sends the authentication challenge when the socket opens", async () => {
    const { bot, sockets } = harness();
    running = bot;
    await bot.start();
    sockets[0]?.open();

    const challenge = (sockets[0]?.sent ?? []).map((payload): unknown => JSON.parse(payload));
    expect(challenge[0]).toMatchObject({
      action: "authentication_challenge",
      data: { token: "bot-token" },
    });
  });

  it("hands every frame to registered listeners", async () => {
    const { bot, sockets } = harness();
    running = bot;
    const seen: unknown[] = [];
    bot.onFrame((frame) => {
      seen.push(frame);
    });
    await bot.start();
    sockets[0]?.open();
    sockets[0]?.message({ event: "posted", data: {}, broadcast: {} });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: "posted" });
  });

  it("does not let a listener rejection escape the message handler", async () => {
    const { bot, sockets } = harness();
    running = bot;
    bot.onFrame(() => Promise.reject(new Error("handler exploded")));
    await bot.start();
    sockets[0]?.open();

    expect(() => sockets[0]?.message({ event: "posted", data: {} })).not.toThrow();
  });

  it("stops delivering to a listener once its unsubscribe runs", async () => {
    const { bot, sockets } = harness();
    running = bot;
    const seen: unknown[] = [];
    const unsubscribe = bot.onFrame((frame) => {
      seen.push(frame);
    });
    await bot.start();
    sockets[0]?.open();
    unsubscribe();
    sockets[0]?.message({ event: "posted", data: {} });

    expect(seen).toHaveLength(0);
  });

  describe("liveness", () => {
    it("starts idle", () => {
      const { bot } = harness();
      expect(bot.liveness()).toMatchObject({
        status: "idle",
        connectedSince: null,
        lastEventAt: null,
        consecutiveFailures: 0,
        lastError: null,
      });
    });

    it("records connected-since on first connect", async () => {
      const { bot, sockets } = harness();
      running = bot;
      await bot.start();
      expect(bot.liveness().status).toBe("connecting");

      sockets[0]?.open();
      expect(bot.liveness()).toMatchObject({
        status: "connected",
        connectedSince: "2026-08-17T12:00:00.000Z",
      });
    });

    it("records the last event timestamp", async () => {
      const { bot, sockets } = harness();
      running = bot;
      await bot.start();
      sockets[0]?.open();
      sockets[0]?.message({ event: "posted", data: {} });

      expect(bot.liveness().lastEventAt).toBe("2026-08-17T12:00:00.000Z");
    });

    it("flips to disconnected and counts consecutive failures", async () => {
      vi.useFakeTimers();
      const { bot, sockets } = harness();
      running = bot;
      await bot.start();
      sockets[0]?.open();
      sockets[0]?.drop();

      expect(bot.liveness()).toMatchObject({
        status: "disconnected",
        connectedSince: null,
        consecutiveFailures: 1,
      });
    });

    it("clears the failure count once the socket reconnects", async () => {
      vi.useFakeTimers();
      const { bot, sockets } = harness();
      running = bot;
      await bot.start();
      sockets[0]?.open();
      sockets[0]?.drop();
      // The vendor client owns the backoff; advancing past it is what schedules the retry.
      await vi.advanceTimersByTimeAsync(10_000);

      expect(sockets.length).toBeGreaterThan(1);
      sockets[sockets.length - 1]?.open();
      expect(bot.liveness()).toMatchObject({ status: "connected", consecutiveFailures: 0 });
    });

    it("records the last socket error", async () => {
      const { bot, sockets } = harness();
      running = bot;
      await bot.start();
      sockets[0]?.fail("ECONNRESET");

      expect(bot.liveness().lastError).toBe("ECONNRESET");
    });

    it("returns to idle after stop", async () => {
      const { bot, sockets } = harness();
      running = bot;
      await bot.start();
      sockets[0]?.open();
      await bot.stop();

      expect(sockets[0]?.closed).toBe(true);
      expect(bot.liveness()).toMatchObject({ status: "idle", connectedSince: null });
    });

    it("hands out a copy so callers cannot mutate the record", async () => {
      const { bot } = harness();
      const snapshot = bot.liveness();
      snapshot.status = "connected";
      expect(bot.liveness().status).toBe("idle");
    });
  });

  it("survives a server sequence gap, which needs a CloseEvent Node does not ship", async () => {
    // Regression: the vendor client builds `new CloseEvent(...)` here. Node 22 has WebSocket but
    // not CloseEvent, so without the shim in bot.ts this throws a ReferenceError mid-handler.
    vi.useFakeTimers();
    const { bot, sockets } = harness();
    running = bot;
    await bot.start();
    sockets[0]?.open();

    expect(() => sockets[0]?.messageOutOfOrder({ event: "posted", data: {} })).not.toThrow();
    expect(sockets[0]?.closed).toBe(true);
    expect(bot.liveness().status).toBe("disconnected");
  });

  it("is idempotent on repeated start", async () => {
    const { bot, sockets } = harness();
    running = bot;
    await bot.start();
    await bot.start();
    expect(sockets).toHaveLength(1);
  });

  it("drops listeners on stop so a stale socket cannot dispatch", async () => {
    const { bot, sockets } = harness();
    running = bot;
    const seen: unknown[] = [];
    bot.onFrame((frame) => {
      seen.push(frame);
    });
    await bot.start();
    sockets[0]?.open();
    await bot.stop();
    sockets[0]?.message({ event: "posted", data: {} });

    expect(seen).toHaveLength(0);
  });
});
