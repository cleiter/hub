import mattermostClient from "@mattermost/client";
import type {
  WebSocketClient as MattermostWebSocketClient,
  WebSocketMessage,
} from "@mattermost/client";
import { z } from "zod";
import { reportFailure } from "../../failures/index.js";
import type { GatewayLiveness } from "../../providers/registration.js";
import { mattermostWebsocketUrl, normalizeMattermostOrigin } from "./client.js";

/**
 * `@mattermost/client` is CommonJS and publishes its exports through `Object.defineProperty`,
 * which Node's ESM named-export lexer cannot see. A named import type-checks and passes under
 * vitest — which does its own interop — and then throws `SyntaxError: Named export
 * 'WebSocketClient' not found` the first time the built app boots under real Node. Take the
 * default export and destructure it instead.
 */
const { WebSocketClient } = mattermostClient;

/**
 * `@mattermost/client` is written for the browser and constructs `new CloseEvent(...)` on two
 * paths it drives itself: a server sequence gap, and a ping that goes unanswered for 30s.
 * Node 22 ships `WebSocket` and `MessageEvent` as globals but **not** `CloseEvent` (verified on
 * 22.22.3), so both paths would throw a ReferenceError — the ping one from inside a timer, where
 * it would take the process down rather than just dropping a frame.
 *
 * The client only ever reads `code` off the event, so a minimal stand-in is enough.
 */
function ensureCloseEvent(): void {
  if ("CloseEvent" in globalThis) return;
  class NodeCloseEvent extends Event {
    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;
    constructor(type: string, init: { code?: number; reason?: string; wasClean?: boolean } = {}) {
      super(type);
      this.code = init.code ?? 0;
      this.reason = init.reason ?? "";
      this.wasClean = init.wasClean ?? false;
    }
  }
  Object.defineProperty(globalThis, "CloseEvent", {
    value: NodeCloseEvent,
    configurable: true,
    writable: true,
  });
}

const MattermostSelfSchema = z
  .object({ id: z.string().min(1), username: z.string().min(1) })
  .passthrough();

const MattermostTeamsSchema = z.array(
  z.object({ id: z.string().min(1), name: z.string().min(1) }).passthrough(),
);

/**
 * Operator-visible gateway health (2A).
 *
 * This exists because a gateway provider has no request log to infer liveness from — the
 * inventory query short-circuits `lastEventAt` to null for gateway providers because it filters
 * on `signature_hash`. Without this record, a dead socket and a quiet channel look identical.
 *
 * NOTE: this is per-process state. A Hub running more than one machine has one record per
 * machine, and the UI must say so rather than implying a single global connection.
 */
export type MattermostGatewayLiveness = GatewayLiveness;

export type MattermostFrameListener = (frame: unknown) => void | Promise<void>;

export interface MattermostBot {
  start(): Promise<void>;
  stop(): Promise<void>;
  onFrame(listener: MattermostFrameListener): () => void;
  getSelfUserId(): string | undefined;
  getSelfUsername(): string | undefined;
  /** Origin of the server this bot is connected to, for building permalinks. */
  serverOrigin(): string;
  /**
   * The team's URL slug, which a permalink needs and the websocket frame never carries. Resolved
   * once at start; `undefined` for a team the bot joined afterwards, or if the lookup failed.
   */
  getTeamName(teamId: string): string | undefined;
  liveness(): MattermostGatewayLiveness;
}

export interface CreateMattermostBotOptions {
  serverUrl: string;
  botToken: string;
  fetch?: typeof fetch;
  /** Injected in tests so the gateway can run without a real socket. */
  newWebSocketFn?: (url: string) => WebSocket;
  now?: () => Date;
}

/**
 * Wraps `@mattermost/client`'s WebSocketClient.
 *
 * Reconnect, exponential backoff with jitter, and `connection_id`/`serverSequence` resync after
 * a missed-message gap are all implemented upstream. Reimplementing them here would be a
 * guaranteed source of subtle bugs, so this file deliberately owns only two things the vendor
 * client does not: the bot's own identity, and the liveness record above.
 */
export function createMattermostBot(options: CreateMattermostBotOptions): MattermostBot {
  const request = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const listeners = new Set<MattermostFrameListener>();

  let socket: MattermostWebSocketClient | undefined;
  let selfUserId: string | undefined;
  let selfUsername: string | undefined;
  const teamNames = new Map<string, string>();
  const state: MattermostGatewayLiveness = {
    status: "idle",
    connectedSince: null,
    lastEventAt: null,
    consecutiveFailures: 0,
    lastError: null,
  };

  async function resolveSelf(): Promise<void> {
    const origin = normalizeMattermostOrigin(options.serverUrl);
    const url = new URL(`${origin.pathname.replace(/\/$/u, "")}/api/v4/users/me`, origin);
    const response = await request(url, {
      headers: { authorization: `Bearer ${options.botToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // A revoked or mistyped token must surface, not retry silently forever.
      throw new Error(`Mattermost bot authentication failed: HTTP ${response.status}`);
    }
    const self = MattermostSelfSchema.parse(await response.json());
    selfUserId = self.id;
    selfUsername = self.username;
  }

  /**
   * Team slugs change rarely and a permalink is cosmetic, so this runs once per connect and a
   * failure is reported rather than thrown: a bot that cannot list its teams must still receive
   * mentions.
   */
  async function resolveTeams(): Promise<void> {
    const origin = normalizeMattermostOrigin(options.serverUrl);
    const url = new URL(`${origin.pathname.replace(/\/$/u, "")}/api/v4/users/me/teams`, origin);
    try {
      const response = await request(url, {
        headers: { authorization: `Bearer ${options.botToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Mattermost team lookup failed: HTTP ${response.status}`);
      teamNames.clear();
      for (const team of MattermostTeamsSchema.parse(await response.json())) {
        teamNames.set(team.id, team.name);
      }
    } catch (error) {
      reportFailure(error, {
        operation: "mattermost.gateway.teams",
        component: "triggers",
        provider: "mattermost",
      });
    }
  }

  return {
    async start() {
      if (socket !== undefined) return;
      ensureCloseEvent();
      state.status = "connecting";
      await resolveSelf();
      await resolveTeams();

      const client = new WebSocketClient(
        options.newWebSocketFn === undefined ? {} : { newWebSocketFn: options.newWebSocketFn },
      );
      socket = client;

      client.addMessageListener((frame: WebSocketMessage) => {
        state.lastEventAt = now().toISOString();
        for (const listener of listeners) {
          void Promise.resolve(listener(frame)).catch((error: unknown) => {
            reportFailure(error, {
              operation: "mattermost.gateway.dispatch",
              component: "triggers",
              provider: "mattermost",
            });
          });
        }
      });
      client.addFirstConnectListener(() => {
        state.status = "connected";
        state.connectedSince = now().toISOString();
        state.consecutiveFailures = 0;
        state.lastError = null;
      });
      client.addReconnectListener(() => {
        state.status = "connected";
        state.connectedSince = now().toISOString();
        state.consecutiveFailures = 0;
        state.lastError = null;
      });
      client.addErrorListener((event: Event) => {
        state.lastError = readErrorMessage(event);
      });
      client.addCloseListener((connectFailCount: number) => {
        state.status = "disconnected";
        state.connectedSince = null;
        state.consecutiveFailures = connectFailCount;
      });

      client.initialize(mattermostWebsocketUrl(options.serverUrl), options.botToken);
    },
    async stop() {
      listeners.clear();
      socket?.close();
      socket = undefined;
      state.status = "idle";
      state.connectedSince = null;
      state.consecutiveFailures = 0;
    },
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSelfUserId: () => selfUserId,
    getSelfUsername: () => selfUsername,
    serverOrigin: () => normalizeMattermostOrigin(options.serverUrl).origin,
    getTeamName: (teamId) => teamNames.get(teamId),
    liveness: () => ({ ...state }),
  };
}

function readErrorMessage(event: Event): string {
  const candidate = event as { message?: unknown; type?: unknown };
  if (typeof candidate.message === "string" && candidate.message.length > 0) {
    return candidate.message;
  }
  return typeof candidate.type === "string" ? candidate.type : "websocket error";
}
