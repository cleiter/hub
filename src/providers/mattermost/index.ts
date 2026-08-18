import type { AuthServer } from "../../auth/server.js";
import type { Database, MattermostConnectionRecord } from "../../db/types.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";
import {
  CONNECTION_ATTEMPT_LIFETIME_MINUTES,
  connectionAccess,
  connectionActionFailure,
  manageConnectionAccess,
  newConnectionState,
  requiredConnectionId,
  stateHash,
} from "../../connections/shared.js";
import { createMattermostBot, type MattermostBot } from "../../triggers/mattermost/bot.js";
import {
  createMattermostBotClient,
  type MattermostBotClient,
} from "../../triggers/mattermost/client.js";
import { createMattermostGatewaySource } from "../../triggers/mattermost/gateway.js";
import { createMattermostTriggerProvider } from "../../triggers/mattermost/provider.js";
import { createMattermostAttachmentResolver } from "../../triggers/mattermost/attachments.js";
import { createMattermostReplyExecutor } from "../../triggers/mattermost/reply.js";
import { outputContextProvider, replyOutputTool } from "../../execution-capabilities/outputs.js";
import { createMattermostConnectionClient, type MattermostConnectionClient } from "./client.js";

export interface MattermostRegistrationConfiguration {
  serverUrl: string;
  botToken: string;
}

export interface CreateMattermostRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  configuration?: MattermostRegistrationConfiguration | null;
  bot?: MattermostBot;
  botClient?: MattermostBotClient;
  connectionClient?: MattermostConnectionClient;
  fetch?: typeof fetch;
  configurationVersion?: number;
  callbackOrigin?: string;
}

export function createMattermostRegistration(
  options: CreateMattermostRegistrationOptions,
): ProviderRegistration {
  const configuration = options.configuration ?? null;
  if (configuration === null) return emptyMattermostRegistration();
  if (options.database === null) return unavailableMattermostRegistration();
  const database = options.database;

  const bot =
    options.bot ??
    createMattermostBot({
      serverUrl: configuration.serverUrl,
      botToken: configuration.botToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const connectionClient =
    options.connectionClient ??
    createMattermostConnectionClient({
      serverUrl: configuration.serverUrl,
      botToken: configuration.botToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });

  /**
   * Every connected team on this Hub uses the same instance-global bot token. Resolving through
   * the connection row rather than returning the token unconditionally is what keeps one
   * organization from acting on another's team — there is no provider-side backstop for it.
   */
  const connectedTeam = async (
    organizationId: string,
    teamId: string,
  ): Promise<MattermostConnectionRecord | undefined> =>
    database.findMattermostConnectionForOrganization(organizationId, teamId);

  const client =
    options.botClient ??
    createMattermostBotClient({
      serverUrl: configuration.serverUrl,
      tokenForTeam: async (organizationId, teamId) =>
        (await connectedTeam(organizationId, teamId)) === undefined
          ? undefined
          : configuration.botToken,
      botUserIdForTeam: async (organizationId, teamId) =>
        (await connectedTeam(organizationId, teamId))?.botUserId,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });

  const connection =
    options.auth === null
      ? mattermostConnectionStatus(true)
      : createMattermostConnection(
          {
            database,
            auth: options.auth,
            configurationVersion: options.configurationVersion ?? 0,
            callbackOrigin: options.callbackOrigin ?? connectionClient.serverOrigin(),
            configuration,
          },
          connectionClient,
        );

  const gateway = createMattermostGatewaySource({
    bot,
    accept: (input) => database.acceptMattermostEvent(input),
  });

  return {
    configurationSnapshot: {
      version: options.configurationVersion ?? 0,
      callbackOrigin: options.callbackOrigin ?? connectionClient.serverOrigin(),
    },
    connection,
    gateway: () => bot.liveness(),
    triggerProviders: [
      ({ configurationStoreForProject, attachments }) =>
        createMattermostTriggerProvider({
          configurationStoreForProject,
          ...(attachments === undefined ? {} : { attachments }),
          botIdentityForTeam: async (organizationId, teamId) => {
            const team = await connectedTeam(organizationId, teamId);
            return team === undefined
              ? undefined
              : { userId: team.botUserId, username: team.botUsername };
          },
          client,
        }),
    ],
    sources: [gateway],
    outputs: [
      {
        type: "mattermost.reply",
        tool: replyOutputTool,
        available: outputContextProvider("mattermost"),
        execute: createMattermostReplyExecutor({ client }),
      },
    ],
    requests: [],
    attachment: { provider: "mattermost", resolve: createMattermostAttachmentResolver(client) },
  };
}

export function emptyMattermostRegistration(): ProviderRegistration {
  return {
    connection: mattermostConnectionStatus(false),
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests: [],
  };
}

function unavailableMattermostRegistration(): ProviderRegistration {
  return {
    connection: mattermostConnectionStatus(true),
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests: [],
  };
}

function mattermostConnectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "mattermost",
    status: (connections) => mattermostStatus(configured, connections.mattermost),
    actions: {},
  };
}

interface MattermostConnectionOptions {
  database: Database;
  auth: AuthServer;
  configurationVersion: number;
  callbackOrigin: string;
  configuration: MattermostRegistrationConfiguration;
}

/**
 * There is no OAuth round trip: Hub already holds the bot's credential, so connecting a team is
 * a single request that binds the teams the bot is already a member of. That is deliberately
 * weaker than the other providers — see the honest-limits note in the operator guide — and is
 * replaced by a connect-time team-admin proof in a later change.
 */
function createMattermostConnection(
  options: MattermostConnectionOptions,
  client: MattermostConnectionClient,
): ProviderConnectionRegistration {
  const start = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      const self = await client.self();
      const teams = await client.botTeams();
      if (teams.length === 0) {
        return Response.json({ error: "mattermost_bot_has_no_teams" }, { status: 409 });
      }
      const authority = connectionAccess(access);
      const connected: string[] = [];
      const unavailable: string[] = [];
      for (const team of teams) {
        /**
         * The bot's team list includes teams that are already connected — by this organization on
         * an earlier run, or by another organization on the same Hub. Binding is exclusive, so
         * attempting one of those throws. Skipping them is what makes "connect another team" work
         * after the bot joins a new team, and what keeps one organization from taking a team that
         * another already holds.
         */
        if ((await options.database.findMattermostConnection(team.teamId)) !== undefined) {
          unavailable.push(team.teamId);
          continue;
        }
        const state = newConnectionState();
        await options.database.startConnectionAttempt({
          provider: "mattermost",
          stateVerifier: stateHash(state),
          access: authority,
          lifetimeMinutes: CONNECTION_ATTEMPT_LIFETIME_MINUTES,
          callbackOrigin: options.callbackOrigin,
          configurationVersion: options.configurationVersion,
          providerApplicationId: client.serverOrigin(),
          configurationSnapshot: {
            provider: "mattermost",
            serverUrl: options.configuration.serverUrl,
          },
          expectedConfigurationVersion: null,
          activateConfiguration: false,
        });
        await options.database.bindMattermostConnection({
          providerApplicationId: client.serverOrigin(),
          stateVerifier: stateHash(state),
          phase: "mattermost_authorization",
          access: authority,
          teamId: team.teamId,
          teamName: team.teamName,
          teamDisplayName: team.teamDisplayName,
          serverUrl: client.serverOrigin(),
          botUserId: self.id,
          botUsername: self.username,
        });
        connected.push(team.teamId);
      }
      if (connected.length === 0) {
        return Response.json(
          { error: "mattermost_teams_already_connected", teams: unavailable },
          { status: 409 },
        );
      }
      return Response.json({ connected });
    } catch (error) {
      return connectionActionFailure(error, "mattermost", "start");
    }
  };

  const disconnect = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      await options.database.disconnectConnection(
        "mattermost",
        requiredConnectionId(request),
        connectionAccess(access),
      );
      return Response.json({ disconnected: true });
    } catch (error) {
      return connectionActionFailure(error, "mattermost", "disconnect");
    }
  };

  return {
    name: "mattermost",
    status: (connections) => mattermostStatus(true, connections.mattermost),
    actions: { start, disconnect },
  };
}

function mattermostStatus(configured: boolean, bindings: readonly MattermostConnectionRecord[]) {
  if (!configured) return { status: "notConfigured" as const };
  return bindings.length === 0
    ? { status: "disconnected" as const }
    : { status: "connected" as const };
}
