import { z } from "zod";
import { normalizeMattermostOrigin } from "../../triggers/mattermost/client.js";

const MATTERMOST_TIMEOUT_MS = 10_000;

const SelfSchema = z.object({ id: z.string().min(1), username: z.string().min(1) });
const TeamSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  display_name: z.string(),
});

export interface MattermostTeamIdentity {
  teamId: string;
  teamName: string;
  teamDisplayName: string;
}

export interface MattermostConnectionClient {
  /** The bot's own identity, used as the connection's provider-side proof of configuration. */
  self(): Promise<{ id: string; username: string }>;
  /** Teams the bot is a member of. A team the bot never joined cannot deliver a single event. */
  botTeams(): Promise<readonly MattermostTeamIdentity[]>;
  serverOrigin(): string;
}

export function createMattermostConnectionClient(options: {
  serverUrl: string;
  botToken: string;
  fetch?: typeof fetch;
}): MattermostConnectionClient {
  const request = options.fetch ?? fetch;
  const origin = normalizeMattermostOrigin(options.serverUrl);
  const apiUrl = (path: string): URL =>
    new URL(`${origin.pathname.replace(/\/$/u, "")}/api/v4${path}`, origin);

  async function call(path: string): Promise<unknown> {
    const response = await request(apiUrl(path), {
      headers: { authorization: `Bearer ${options.botToken}` },
      signal: AbortSignal.timeout(MATTERMOST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Mattermost request failed: ${path} returned HTTP ${response.status}`);
    }
    return response.json();
  }

  return {
    async self() {
      return SelfSchema.parse(await call("/users/me"));
    },
    async botTeams() {
      const teams = z.array(TeamSchema).parse(await call("/users/me/teams"));
      return teams.map((team) => ({
        teamId: team.id,
        teamName: team.name,
        teamDisplayName: team.display_name.length > 0 ? team.display_name : team.name,
      }));
    },
    serverOrigin: () => origin.origin,
  };
}
