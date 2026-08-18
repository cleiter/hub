import type { MattermostBot, MattermostFrameListener, MattermostGatewayLiveness } from "./bot.js";

export interface MemoryMattermostBot extends MattermostBot {
  /** Pushes a raw websocket frame to every listener, as the real gateway would. */
  emit(frame: unknown): Promise<void>;
  started: () => boolean;
  setSelf(userId: string | undefined, username?: string): void;
  setTeamName(teamId: string, name: string): void;
  setLiveness(patch: Partial<MattermostGatewayLiveness>): void;
}

/**
 * In-memory stand-in for the websocket gateway, patterned on discord/memory-bot.ts. Lets tests
 * drive frames through the real gateway code without a socket or a server.
 */
export function createMemoryMattermostBot(
  options: { userId?: string; username?: string; serverUrl?: string } = {},
): MemoryMattermostBot {
  const teamNames = new Map<string, string>();
  const listeners = new Set<MattermostFrameListener>();
  let running = false;
  let selfUserId: string | undefined = options.userId ?? "bot-user";
  let selfUsername: string | undefined = options.username ?? "paseobot";
  let liveness: MattermostGatewayLiveness = {
    status: "idle",
    connectedSince: null,
    lastEventAt: null,
    consecutiveFailures: 0,
    lastError: null,
  };

  return {
    async start() {
      running = true;
      liveness = { ...liveness, status: "connected", connectedSince: new Date(0).toISOString() };
    },
    async stop() {
      running = false;
      listeners.clear();
      liveness = { ...liveness, status: "idle", connectedSince: null };
    },
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSelfUserId: () => selfUserId,
    getSelfUsername: () => selfUsername,
    serverOrigin: () => options.serverUrl ?? "https://mattermost.example.com",
    getTeamName: (teamId) => teamNames.get(teamId),
    liveness: () => ({ ...liveness }),
    async emit(frame) {
      liveness = { ...liveness, lastEventAt: new Date().toISOString() };
      // Snapshot: a listener may unsubscribe itself while the frame is being dispatched.
      const snapshot = Array.from(listeners);
      for (const listener of snapshot) await listener(frame);
    },
    started: () => running,
    setTeamName(teamId, name) {
      teamNames.set(teamId, name);
    },
    setSelf(userId, username) {
      selfUserId = userId;
      selfUsername = username;
    },
    setLiveness(patch) {
      liveness = { ...liveness, ...patch };
    },
  };
}
