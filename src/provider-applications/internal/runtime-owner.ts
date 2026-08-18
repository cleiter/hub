import type { AuthServer } from "../../auth/server.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { GitHubConfigurationProvider } from "../../configuration/github-sync.js";
import type { Database } from "../../db/types.js";
import { outputContextProvider, replyOutputTool } from "../../execution-capabilities/outputs.js";
import { logger } from "../../logger.js";
import { reportFailure } from "../../failures/index.js";
import { createDiscordRegistration } from "../../providers/discord/index.js";
import { createGitHubRegistration } from "../../providers/github/index.js";
import { createLinearRegistration } from "../../providers/linear/index.js";
import { createMattermostRegistration } from "../../providers/mattermost/index.js";
import { mattermostStartRefusal } from "../../providers/mattermost/refusals.js";
import type {
  GatewayLiveness,
  ProviderRegistration,
  TriggerProviderResources,
} from "../../providers/registration.js";
import { createSlackRegistration } from "../../providers/slack/index.js";
import type { TriggerHandler, TriggerProvider, TriggerSource } from "../../triggers/index.js";
import {
  PROVIDERS,
  ProviderConnectionRefusedError,
  type Provider,
  type ProviderApplicationConfiguration,
  type ProviderApplicationIdentity,
  type ProviderRuntimeCandidate,
  type ProviderRuntimeOwner,
} from "../index.js";
import { parseProviderApplicationConfiguration } from "./store.js";
import type { SlackDeliveryStatus } from "../../triggers/slack/source/index.js";
import { GITHUB_TRIGGER_SOURCE_NAMES } from "../../triggers/github/classification.js";

/**
 * What a provider's `start` action may return: a URL to redirect the browser to, or — for a
 * gateway provider that already holds its credential — the resources it just bound.
 */
const CONNECTION_START_SCHEMA = z.union([
  z.object({ url: z.string().url() }),
  z.object({ connected: z.array(z.string()) }),
]);

interface Slot {
  active: ActiveRegistration | undefined;
  identity: ProviderApplicationIdentity | undefined;
  triggerResources: TriggerProviderResources | undefined;
  handler: TriggerHandler | undefined;
}

interface ActiveRegistration {
  provider: Provider;
  registration: ProviderRegistration;
  triggers: readonly TriggerProvider[];
  sourcesStarted: boolean;
  acceptingEvents: boolean;
  leases: number;
  retiring: boolean;
  retirement: Promise<void> | undefined;
}

class ProviderRuntimeUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code.replaceAll("_", " "));
    this.name = "ProviderRuntimeUnavailableError";
  }
}

function unavailable(code: string): ProviderRuntimeUnavailableError {
  return new ProviderRuntimeUnavailableError(code);
}

type SlackInstallationHandler = Parameters<
  NonNullable<ProviderRuntimeOwner["onSlackInstallation"]>
>[0];
type LinearInstallationHandler = Parameters<
  NonNullable<ProviderRuntimeOwner["onLinearInstallation"]>
>[0];

interface DynamicProviderRuntimeOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  fetch?: typeof fetch;
  registrationFactory?: (input: {
    provider: Provider;
    configuration: ProviderApplicationConfiguration;
    callbackOrigin: string;
    configurationVersion: number;
    expectedConfigurationVersion: number | undefined;
    activateConfiguration: boolean;
    onVerifiedSlackInstallation: SlackInstallationHandler;
    onVerifiedLinearInstallation: LinearInstallationHandler;
  }) => ProviderRegistration;
}

/** The options every provider registration is built from, whatever else it needs on top. */
interface SharedRegistrationOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  publicBaseUrl: string;
  configurationVersion: number;
  fetch?: typeof fetch;
}

/** @package */
export class DynamicProviderRuntime implements ProviderRuntimeOwner {
  private readonly slots = new Map<Provider, Slot>(
    PROVIDERS.map((provider) => [provider, emptySlot()]),
  );
  private readonly stable = new Map<Provider, ProviderRegistration>();
  private slackInstallationHandler: SlackInstallationHandler | undefined;
  private linearInstallationHandler: LinearInstallationHandler | undefined;

  constructor(private readonly options: DynamicProviderRuntimeOptions) {
    for (const provider of PROVIDERS) {
      this.stable.set(provider, this.stableRegistration(provider));
    }
  }

  /** Derived from `PROVIDERS` so a new provider cannot be silently left unregistered. */
  registrations(): readonly ProviderRegistration[] {
    return PROVIDERS.map((provider) => this.stable.get(provider)!);
  }

  identity(provider: Provider): ProviderApplicationIdentity | undefined {
    return this.slot(provider).identity;
  }

  slackDelivery(): { status(): SlackDeliveryStatus; retry(): Promise<void> } | undefined {
    return this.slot("slack").active?.registration.slackDelivery;
  }

  /**
   * Read from the published registration rather than a cached copy: after a configuration bump
   * the old socket is gone, and reporting its last known state would be a lie.
   */
  gatewayLiveness(provider: Provider): GatewayLiveness | undefined {
    return this.slot(provider).active?.registration.gateway?.();
  }

  onSlackInstallation(
    handler: NonNullable<DynamicProviderRuntime["slackInstallationHandler"]>,
  ): void {
    this.slackInstallationHandler = handler;
  }

  onLinearInstallation(
    handler: NonNullable<DynamicProviderRuntime["linearInstallationHandler"]>,
  ): void {
    this.linearInstallationHandler = handler;
  }

  async prepare(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
    callbackOrigin: string,
    identity: ProviderApplicationIdentity,
    configurationVersion: number,
    activation?: {
      expectedConfigurationVersion: number | undefined;
      activateConfiguration: boolean;
    },
  ): Promise<ProviderRuntimeCandidate> {
    const registration = this.build(
      provider,
      configuration,
      callbackOrigin,
      configurationVersion,
      activation,
    );
    const slot = this.slot(provider);
    const triggerResources = slot.triggerResources;
    const active: ActiveRegistration = {
      provider,
      registration,
      triggers:
        triggerResources === undefined
          ? []
          : registration.triggerProviders
              .map((factory) => factory(triggerResources))
              .filter((trigger): trigger is TriggerProvider => trigger !== undefined),
      sourcesStarted: false,
      acceptingEvents: false,
      leases: 0,
      retiring: false,
      retirement: undefined,
    };
    let published = false;
    return {
      start: async () => {
        if (slot.handler === undefined) return;
        await startSources(active, slot.handler);
      },
      beginConnection: async (request) => {
        const response = await registration.connection.actions["start"]?.(request);
        if (response === undefined) throw unavailable("provider_application_unavailable");
        if (!response.ok) {
          // Only Mattermost authors these codes today, and an unrecognized body yields
          // undefined, so this is safe to try for every provider.
          const refusal = await mattermostStartRefusal(response);
          if (refusal !== undefined) throw new ProviderConnectionRefusedError(refusal);
          throw unavailable("provider_application_unavailable");
        }
        const body: unknown = await response.json();
        // A gateway provider already holds its credential, so its connect finishes here instead
        // of handing back a URL. Requiring a URL made "Connect a team" unreachable for Mattermost.
        const start = CONNECTION_START_SCHEMA.safeParse(body);
        if (!start.success) throw unavailable("provider_application_unavailable");
        return start.data;
      },
      publish: () => {
        const previous = slot.active;
        if (previous !== undefined) previous.acceptingEvents = false;
        slot.active = active;
        slot.identity = identity;
        active.acceptingEvents = true;
        published = true;
        if (previous !== undefined) {
          previous.retiring = true;
          void stopSources(previous).catch((error: unknown) => {
            reportFailure(error, {
              operation: "provider_runtime.retire_inbound",
              component: "provider_runtime",
              provider,
            });
          });
          void this.retireWhenDrained(provider, previous);
        }
      },
      close: () => (published ? Promise.resolve() : stopSources(active)),
    };
  }

  private build(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
    callbackOrigin: string,
    configurationVersion: number,
    activation?: {
      expectedConfigurationVersion: number | undefined;
      activateConfiguration: boolean;
    },
  ): ProviderRegistration {
    if (this.options.registrationFactory !== undefined) {
      return this.options.registrationFactory(
        this.customRegistrationInput(
          provider,
          configuration,
          callbackOrigin,
          configurationVersion,
          activation,
        ),
      );
    }
    const shared = {
      database: this.options.database,
      auth: this.options.auth,
      applicationBaseUrl: this.options.applicationBaseUrl,
      publicBaseUrl: callbackOrigin,
      configurationVersion,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
    };
    return this.buildProvider(provider, configuration, callbackOrigin, shared, activation);
  }

  /**
   * Split out of `build` so that adding a provider costs one branch here rather than pushing the
   * whole of `build` — factory override, shared options, and dispatch — past its complexity budget.
   */
  private buildProvider(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
    callbackOrigin: string,
    shared: SharedRegistrationOptions,
    activation:
      | {
          expectedConfigurationVersion: number | undefined;
          activateConfiguration: boolean;
        }
      | undefined,
  ): ProviderRegistration {
    if (provider === "github" && configuration.provider === "github") {
      return createGitHubRegistration({ ...shared, configuration });
    }
    if (provider === "slack" && configuration.provider === "slack") {
      return createSlackRegistration({
        ...shared,
        configuration,
        ...(activation?.expectedConfigurationVersion === undefined
          ? {}
          : { expectedConfigurationVersion: activation.expectedConfigurationVersion }),
        activateConfiguration: activation?.activateConfiguration ?? false,
        onVerifiedInstallation: (input) => this.handleSlackInstallation(input),
      });
    }
    if (provider === "discord" && configuration.provider === "discord") {
      return createDiscordRegistration({
        ...shared,
        configuration: {
          clientId: configuration.applicationId,
          clientSecret: configuration.clientSecret,
          botToken: configuration.botToken,
        },
      });
    }
    if (provider === "linear" && configuration.provider === "linear") {
      return createLinearRegistration({
        ...shared,
        configuration,
        ...(activation?.expectedConfigurationVersion === undefined
          ? {}
          : { expectedConfigurationVersion: activation.expectedConfigurationVersion }),
        activateConfiguration: activation?.activateConfiguration ?? false,
        onVerifiedInstallation: (input) => this.handleLinearInstallation(input),
      });
    }
    if (provider === "mattermost" && configuration.provider === "mattermost") {
      return createMattermostRegistration({
        ...shared,
        callbackOrigin,
        configuration: {
          serverUrl: configuration.serverUrl,
          botToken: configuration.botToken,
        },
      });
    }
    throw new Error("provider configuration mismatch");
  }

  private customRegistrationInput(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
    callbackOrigin: string,
    configurationVersion: number,
    activation:
      | {
          expectedConfigurationVersion: number | undefined;
          activateConfiguration: boolean;
        }
      | undefined,
  ): Parameters<NonNullable<DynamicProviderRuntimeOptions["registrationFactory"]>>[0] {
    return {
      provider,
      configuration,
      callbackOrigin,
      configurationVersion,
      expectedConfigurationVersion: activation?.expectedConfigurationVersion,
      activateConfiguration: activation?.activateConfiguration ?? false,
      onVerifiedSlackInstallation: (input) => this.handleSlackInstallation(input),
      onVerifiedLinearInstallation: (input) => this.handleLinearInstallation(input),
    };
  }

  private handleSlackInstallation(input: Parameters<SlackInstallationHandler>[0]): Promise<void> {
    if (this.slackInstallationHandler === undefined) {
      throw unavailable("slack_installation_handler_unavailable");
    }
    return this.slackInstallationHandler(input);
  }

  private handleLinearInstallation(input: Parameters<LinearInstallationHandler>[0]): Promise<void> {
    if (this.linearInstallationHandler === undefined) {
      throw unavailable("linear_installation_handler_unavailable");
    }
    return this.linearInstallationHandler(input);
  }

  private stableRegistration(provider: Provider): ProviderRegistration {
    const slot = this.slot(provider);
    const source: TriggerSource = {
      start: async (handler) => {
        slot.handler = handler;
        if (slot.active !== undefined) await startSources(slot.active, handler);
      },
      stop: async () => {
        slot.handler = undefined;
        if (slot.active !== undefined) {
          slot.active.acceptingEvents = false;
          await stopSources(slot.active);
        }
      },
    };
    const connectionActions = Object.fromEntries(
      actionNames(provider).map((action) => [
        action,
        async (request: Request) => {
          const active = await this.registrationForAction(provider, slot, action, request);
          if (active === undefined) {
            return Response.json({ error: "provider_not_configured" }, { status: 409 });
          }
          return this.withLease(
            active,
            () =>
              active.registration.connection.actions[action]?.(request) ??
              Promise.resolve(Response.json({ error: "provider_not_configured" }, { status: 409 })),
          );
        },
      ]),
    );
    return {
      connection: {
        name: provider,
        status: (connections) =>
          slot.active?.registration.connection.status(connections) ?? {
            status: "notConfigured" as const,
          },
        actions: connectionActions,
      },
      ...(provider === "github"
        ? {
            integration: {
              resolve: (
                ...args: Parameters<NonNullable<ProviderRegistration["integration"]>["resolve"]>
              ) => {
                const active = slot.active;
                const integration = active?.registration.integration;
                if (active === undefined || integration === undefined) {
                  throw unavailable("github_integration_unavailable");
                }
                return this.withLease(active, () => integration.resolve(...args));
              },
              githubAuthority: {
                mint: (
                  input: Parameters<
                    NonNullable<
                      NonNullable<ProviderRegistration["integration"]>["githubAuthority"]
                    >["mint"]
                  >[0],
                ) => {
                  const active = slot.active;
                  const authority = active?.registration.integration?.githubAuthority;
                  if (active === undefined || authority === undefined) {
                    throw unavailable("github_authority_unavailable");
                  }
                  return this.withLease(active, () => authority.mint(input));
                },
                revoke: (token: string) => {
                  const active = slot.active;
                  const authority = active?.registration.integration?.githubAuthority;
                  if (active === undefined || authority === undefined) {
                    throw unavailable("github_authority_unavailable");
                  }
                  return this.withLease(active, () => authority.revoke(token));
                },
              },
            },
          }
        : {}),
      triggerProviders: [
        (resources) => {
          slot.triggerResources = resources;
          if (slot.active !== undefined) {
            slot.active.triggers = slot.active.registration.triggerProviders
              .map((factory) => factory(resources))
              .filter((trigger): trigger is TriggerProvider => trigger !== undefined);
          }
          return this.dynamicTrigger(provider, slot);
        },
      ],
      sources: [source],
      outputs:
        provider === "github"
          ? []
          : [
              {
                type: `${provider}.reply`,
                tool: replyOutputTool,
                available: outputContextProvider(provider),
                execute: (input) => {
                  const active = slot.active;
                  const output = active?.registration.outputs.find(
                    (candidate) => candidate.type === `${provider}.reply`,
                  );
                  if (active === undefined || output === undefined) {
                    throw unavailable(`${provider}_output_unavailable`);
                  }
                  return this.withLease(active, () => output.execute(input));
                },
              },
            ],
      // Gateway providers connect out to the service, so they expose no inbound HTTP route.
      requests:
        provider === "discord" || provider === "mattermost"
          ? []
          : [
              {
                name: provider === "github" ? "webhook" : `${provider}.events`,
                handle: (request) => {
                  const active = slot.active;
                  const handler = active?.registration.requests[0];
                  return active === undefined || handler === undefined
                    ? Promise.resolve(new Response("Not Found", { status: 404 }))
                    : this.withLease(active, () => handler.handle(request));
                },
              },
            ],
      ...(provider === "github"
        ? { githubConfiguration: this.dynamicGitHubConfiguration(slot) }
        : {}),
      ...(provider === "slack" || provider === "discord" || provider === "mattermost"
        ? {
            attachment: {
              provider,
              resolve: (input) => {
                const active = slot.active;
                const attachment = active?.registration.attachment;
                if (active === undefined || attachment === undefined) {
                  throw unavailable(`${provider}_attachment_unavailable`);
                }
                return this.withLease(active, () => attachment.resolve(input));
              },
            },
          }
        : {}),
    };
  }

  private slot(provider: Provider): Slot {
    const slot = this.slots.get(provider);
    if (slot === undefined) throw new Error(`unknown provider: ${provider}`);
    return slot;
  }

  private dynamicTrigger(provider: Provider, slot: Slot): TriggerProvider {
    const current = () => {
      const active = slot.active;
      const trigger = active?.triggers[0];
      if (active === undefined || trigger === undefined) {
        throw unavailable(`${provider}_trigger_unavailable`);
      }
      return { active, trigger };
    };
    const invoke = <T>(operation: (trigger: TriggerProvider) => Promise<T>) => {
      const selected = current();
      return this.withLease(selected.active, () => operation(selected.trigger));
    };
    return {
      name: provider,
      eventNames: eventNames(provider),
      match: async (external) => {
        const selected = current();
        return this.withLease(selected.active, () => selected.trigger.match(external));
      },
      materializeLaunch: (input) =>
        invoke((trigger) => trigger.materializeLaunch?.(input) ?? Promise.resolve({})),
      materializeContext: (input) =>
        invoke((trigger) => trigger.materializeContext?.(input) ?? Promise.resolve(undefined)),
      onDispatchAccepted: (triggerContext, outputContext, reactionState) =>
        invoke(
          (trigger) =>
            trigger.onDispatchAccepted?.(triggerContext, outputContext, reactionState) ??
            Promise.resolve(),
        ),
      onAgentExecutionStarted: (triggerContext, outputContext, reactionState) =>
        invoke(
          (trigger) =>
            trigger.onAgentExecutionStarted?.(triggerContext, outputContext, reactionState) ??
            Promise.resolve(),
        ),
      onAgentExecutionCompleted: (triggerContext, outputContext, result, reactionState) =>
        invoke(
          (trigger) =>
            trigger.onAgentExecutionCompleted?.(
              triggerContext,
              outputContext,
              result,
              reactionState,
            ) ?? Promise.resolve(),
        ),
      onAgentExecutionFailed: (triggerContext, outputContext, reason, reactionState) =>
        invoke(
          (trigger) =>
            trigger.onAgentExecutionFailed?.(
              triggerContext,
              outputContext,
              reason,
              reactionState,
            ) ?? Promise.resolve(),
        ),
      onAgentExecutionTerminal: (executionId, triggerContext) =>
        invoke(
          (trigger) =>
            trigger.onAgentExecutionTerminal?.(executionId, triggerContext) ?? Promise.resolve(),
        ),
      onMachineTerminated: (triggerContext, reason, reactionState) =>
        invoke(
          (trigger) =>
            trigger.onMachineTerminated?.(triggerContext, reason, reactionState) ??
            Promise.resolve(),
        ),
    };
  }

  private dynamicGitHubConfiguration(slot: Slot): GitHubConfigurationProvider {
    const invoke = <T>(operation: (configuration: GitHubConfigurationProvider) => Promise<T>) => {
      const active = slot.active;
      const configuration = active?.registration.githubConfiguration;
      if (active === undefined || configuration === undefined) {
        throw unavailable("github_configuration_unavailable");
      }
      return this.withLease(active, () => operation(configuration));
    };
    return {
      listInstallationRepositories: (input) =>
        invoke((configuration) => configuration.listInstallationRepositories(input)),
      readDefaultBranchHead: (input) =>
        invoke((configuration) => configuration.readDefaultBranchHead(input)),
      listFilesAtCommit: (input) =>
        invoke((configuration) => configuration.listFilesAtCommit(input)),
      readFileAtCommit: (input) => invoke((configuration) => configuration.readFileAtCommit(input)),
    };
  }

  private async withLease<T>(active: ActiveRegistration, operation: () => Promise<T>): Promise<T> {
    active.leases += 1;
    try {
      return await operation();
    } finally {
      active.leases -= 1;
      if (active.retiring) {
        void this.retireWhenDrained(active.provider, active);
      }
    }
  }

  private retireWhenDrained(provider: Provider, active: ActiveRegistration): Promise<void> {
    if (active.leases > 0) return Promise.resolve();
    active.retirement ??= retire(provider, active);
    return active.retirement;
  }

  private async registrationForAction(
    provider: Provider,
    slot: Slot,
    action: string,
    request: Request,
  ): Promise<ActiveRegistration | undefined> {
    if (action !== "callback" && action !== "setup") return slot.active;
    const state = new URL(request.url).searchParams.get("state");
    if (state === null) return slot.active;
    const snapshot = await this.options.database.findConnectionAttemptConfiguration(
      createHash("sha256").update(state).digest("hex"),
    );
    if (snapshot === undefined) return slot.active;
    const existing =
      slot.active?.registration.configurationSnapshot?.version === snapshot.configurationVersion &&
      slot.active.registration.configurationSnapshot.callbackOrigin === snapshot.callbackOrigin
        ? slot.active
        : undefined;
    if (existing !== undefined) return existing;
    try {
      const configuration = parseProviderApplicationConfiguration(snapshot.configurationSnapshot);
      if (configuration.provider !== provider) return slot.active;
      const registration = this.build(
        provider,
        configuration,
        snapshot.callbackOrigin,
        snapshot.configurationVersion,
        {
          expectedConfigurationVersion: snapshot.expectedConfigurationVersion ?? undefined,
          activateConfiguration: snapshot.activateConfiguration,
        },
      );
      const restored: ActiveRegistration = {
        provider,
        registration,
        triggers: [],
        sourcesStarted: false,
        acceptingEvents: false,
        leases: 0,
        retiring: false,
        retirement: undefined,
      };
      return restored;
    } catch (error) {
      reportFailure(error, {
        operation: "provider_runtime.restore_callback_snapshot",
        component: "provider_runtime",
        provider,
      });
      return slot.active;
    }
  }
}

function emptySlot(): Slot {
  return {
    active: undefined,
    identity: undefined,
    triggerResources: undefined,
    handler: undefined,
  };
}

function actionNames(provider: Provider): readonly string[] {
  if (provider === "github") return ["start", "disconnect", "setup", "callback"];
  // Mattermost has no OAuth round trip, so there is no callback to expose.
  if (provider === "mattermost") return ["start", "disconnect"];
  return ["start", "disconnect", "callback"];
}

function eventNames(provider: Provider): TriggerProvider["eventNames"] {
  if (provider === "slack") return ["slack.mention"];
  if (provider === "discord") return ["discord.mention"];
  if (provider === "linear") return ["linear.issue", "linear.comment"];
  if (provider === "mattermost") return ["mattermost.mention"];
  return GITHUB_TRIGGER_SOURCE_NAMES;
}

async function startSources(active: ActiveRegistration, handler: TriggerHandler): Promise<void> {
  if (active.sourcesStarted) return;
  const started: TriggerSource[] = [];
  try {
    for (const source of active.registration.sources) {
      await source.start((trigger) =>
        active.acceptingEvents
          ? handler(trigger)
          : Promise.reject(new Error("provider source was retired")),
      );
      started.push(source);
    }
    active.sourcesStarted = true;
  } catch (error) {
    const cleanup = await Promise.allSettled(started.toReversed().map((source) => source.stop()));
    for (const failure of cleanup) {
      if (failure.status === "rejected") {
        reportFailure(failure.reason, {
          operation: "provider_runtime.start_sources.cleanup",
          component: "provider_runtime",
          provider: active.provider,
        });
      }
    }
    throw error;
  }
}

async function stopSources(active: ActiveRegistration): Promise<void> {
  if (!active.sourcesStarted) return;
  active.sourcesStarted = false;
  const results = await Promise.allSettled(
    active.registration.sources.toReversed().map((source) => source.stop()),
  );
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}

async function retire(provider: Provider, active: ActiveRegistration): Promise<void> {
  try {
    await stopSources(active);
  } catch (error) {
    reportFailure(
      error,
      { operation: "provider_runtime.retire", component: "provider_runtime", provider },
      { logger, kind: "internal" },
    );
  }
}
