import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type { CompiledTriggerConfig } from "../../config/index.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentDescriptor,
} from "../../attachments/capabilities.js";
import { reportFailure } from "../../failures/index.js";
import {
  type TriggerProvider,
  type TriggerProviderMatch,
  type TriggerProviderReactionState,
} from "../index.js";
import type { MattermostBotClient, MattermostThreadMessage } from "./client.js";
import {
  NormalizedMattermostMentionEventSchema,
  type NormalizedMattermostMentionEvent,
} from "./events.js";
import {
  matchMattermostTriggers,
  readMattermostInvocationParserMessage,
  readMattermostPromptBody,
} from "./match.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import {
  addReaction,
  reactionPhase,
  removeReactionForPhase,
  replaceReaction,
  type ReactionPort,
} from "../reactions.js";

export interface MattermostAttachmentLocator {
  id: string;
  filename: string;
  content_type: string | null;
  size: number | null;
}

interface MattermostThreadContextLocator {
  status: "deferred";
  channel: { id: string };
  thread: { root_id: string };
  before: { post_id: string };
}

export interface MattermostMergeData {
  mattermost: {
    event_type: "mention";
    post_id: string;
    create_at: number;
    connection_id: string | null;
    team: { id: string };
    trigger_message: {
      post_id: string;
      content: string;
      body: string;
      author: { id: string; username?: string | undefined };
      channel: { id: string; type: string };
      thread: { root_id: string } | null;
      created_at: string;
      attachments: MattermostAttachmentLocator[];
    };
    trigger_thread_context: MattermostThreadContextLocator | { status: "not_applicable" };
  };
}

interface MattermostMergeMessage {
  post_id: string;
  content: string;
  author: { id: string };
  channel: { id: string };
  created_at: string;
  attachments: AttachmentDescriptor[];
}

interface MattermostContextPayload {
  status: "available" | "incomplete" | "unavailable" | "not_applicable";
  messages: MattermostMergeMessage[];
}

export interface MattermostMaterializedContext {
  mattermost: { thread: MattermostContextPayload };
}

export interface MattermostTriggerContext {
  provider: "mattermost";
  target: MattermostOutputContext;
  event: MattermostMergeData;
}

export interface MattermostOutputContext {
  provider: "mattermost";
  organizationId: string;
  teamId: string;
  channelId: string;
  /** Thread to reply into. Equals the post id when the trigger message is itself a root post. */
  rootId: string;
  postId: string;
}

/**
 * Emoji names must exist in the target Mattermost's emoji set. These four are part of the
 * standard set shipped with the server; the gated live contract test is what confirms them
 * against a specific server version, and a missing name degrades to a dropped reaction rather
 * than a failed run.
 */
const REACTION_ACCEPTED = "eyes";
const REACTION_STARTED = "hourglass_flowing_sand";
const REACTION_SUCCEEDED = "white_check_mark";
const REACTION_FAILED = "x";

export function createMattermostTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  botIdentityForTeam(
    organizationId: string,
    teamId: string,
  ): Promise<{ userId: string; username: string } | undefined>;
  client: MattermostBotClient;
  attachments?: AttachmentCapabilityRegistry;
}): TriggerProvider<
  "mattermost",
  MattermostTriggerContext,
  MattermostOutputContext,
  MattermostMaterializedContext
> {
  return {
    name: "mattermost",
    eventNames: ["mattermost.mention"],
    async match(trigger) {
      const event = NormalizedMattermostMentionEventSchema.parse(trigger.payload);
      const identity = await options.botIdentityForTeam(trigger.organizationId, event.teamId);
      if (identity === undefined) return "configuration_unavailable";
      const stored = await options
        .configurationStoreForProject(trigger.projectId)
        .getRevision(trigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (!stored.configuration.triggers.some((candidate) => candidate.on === trigger.source))
        return "no_trigger_for_source";

      const matchedTriggers = matchMattermostTriggers(
        stored.configuration,
        event,
        identity.userId,
        identity.username,
        trigger.connectionId,
      );
      if (matchedTriggers.length === 0) return "trigger_filters_rejected";
      const matches: TriggerProviderMatch<MattermostTriggerContext, MattermostOutputContext>[] = [];

      for (const match of matchedTriggers) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiledTrigger === undefined)
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
        const outputContext: MattermostOutputContext = {
          provider: "mattermost",
          organizationId: trigger.organizationId,
          teamId: event.teamId,
          channelId: event.channelId,
          rootId: event.rootId ?? event.postId,
          postId: event.postId,
        };
        const triggerContext: MattermostTriggerContext = {
          provider: "mattermost",
          target: outputContext,
          event: buildMattermostMergeData(event, identity.username, trigger.connectionId),
        };
        const invocation = parseInvocation(
          event.content,
          compiledTrigger.inputs,
          undefined,
          readMattermostInvocationParserMessage(event, identity.username, compiledTrigger.filters),
        );
        if (invocation.status === "rejected") {
          matches.push({
            triggerName: match.trigger.name,
            triggerContext,
            outputContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          });
          continue;
        }
        if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
        matches.push({
          triggerName: match.trigger.name,
          triggerContext,
          outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
          invocation,
        });
      }
      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },

    async materializeContext(launch): Promise<MattermostMaterializedContext> {
      const locator = launch.triggerContext.event.mattermost.trigger_thread_context;
      if (locator.status === "not_applicable") {
        return { mattermost: { thread: { status: "not_applicable", messages: [] } } };
      }
      if (options.client.readThreadMessages === undefined) {
        return { mattermost: { thread: { status: "unavailable", messages: [] } } };
      }
      const teamId = launch.triggerContext.event.mattermost.team.id;
      let history;
      try {
        history = await options.client.readThreadMessages({
          organizationId: launch.organizationId,
          teamId,
          rootId: locator.thread.root_id,
          beforePostId: locator.before.post_id,
        });
      } catch (error) {
        reportFailure(
          error,
          { operation: "mattermost.thread.hydrate", component: "triggers", provider: "mattermost" },
          { diagnostic: { teamId, channelId: locator.channel.id } },
        );
        return { mattermost: { thread: { status: "unavailable", messages: [] } } };
      }
      const messages = await Promise.all(
        history.messages.map(async (message) => ({
          post_id: message.postId,
          content: message.content,
          author: message.author,
          channel: { id: locator.channel.id },
          created_at: message.createdAt,
          attachments: await registerAttachments(
            message.attachments,
            launch.providerEventReceiptId,
            launch.organizationId,
            teamId,
            launch.triggerContext.event.mattermost.connection_id,
            launch.executionId,
            options.attachments,
          ),
        })),
      );
      return {
        mattermost: {
          thread: { status: history.complete ? "available" : "incomplete", messages },
        },
      };
    },

    async onDispatchAccepted(_triggerContext, _outputContext, reactionState) {
      if (reactionPhase(reactionState) !== undefined) return reactionState;
      return { phase: "accepted" };
    },
    async onAgentExecutionStarted(context, _outputContext, reactionState) {
      if (reactionPhase(reactionState) === "started") return reactionState;
      await replaceReaction(
        reactionPort(options.client, context.target),
        REACTION_ACCEPTED,
        REACTION_STARTED,
      );
      return { phase: "started" };
    },
    async onAgentExecutionCompleted(context, _outputContext, _result, reactionState) {
      const port = reactionPort(options.client, context.target);
      await removeReactionForPhase(port, reactionState, "started");
      await addReaction(port, REACTION_SUCCEEDED);
      return null;
    },
    async onAgentExecutionFailed(context, _output, reason, reactionState) {
      await failWithNotice(options.client, context.target, reason, reactionState);
      return null;
    },
    async onMachineTerminated(context, reason, reactionState) {
      if (reason === "launch_failed" || reason === "daemon_disconnected") {
        await failWithNotice(options.client, context.target, reason, reactionState);
        return null;
      }
      return reactionState;
    },
  };
}

/** Binds the shared reaction machine to one Mattermost post. */
function reactionPort(client: MattermostBotClient, target: MattermostOutputContext): ReactionPort {
  const scope = {
    organizationId: target.organizationId,
    teamId: target.teamId,
    postId: target.postId,
  };
  return {
    provider: "mattermost",
    emoji: { accepted: REACTION_ACCEPTED, started: REACTION_STARTED },
    add: (name) => client.addReaction({ ...scope, name }),
    remove: (name) => client.removeReaction({ ...scope, name }),
    diagnostic: (name) => ({ teamId: target.teamId, reaction: name }),
  };
}

function buildMattermostMergeData(
  event: NormalizedMattermostMentionEvent,
  botUsername: string,
  connectionId: string | null | undefined,
): MattermostMergeData {
  return {
    mattermost: {
      event_type: "mention",
      post_id: event.postId,
      create_at: event.createAt,
      connection_id: connectionId ?? null,
      team: { id: event.teamId },
      trigger_message: {
        post_id: event.postId,
        content: event.content,
        body: readMattermostPromptBody(event, botUsername),
        author: event.author,
        channel: { id: event.channelId, type: event.channelType },
        thread: event.rootId === null ? null : { root_id: event.rootId },
        created_at: event.createdAt,
        attachments: event.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          content_type: attachment.contentType,
          size: attachment.size,
        })),
      },
      trigger_thread_context:
        event.rootId === null
          ? { status: "not_applicable" }
          : {
              status: "deferred",
              channel: { id: event.channelId },
              thread: { root_id: event.rootId },
              before: { post_id: event.postId },
            },
    },
  };
}

async function registerAttachments(
  source: MattermostThreadMessage["attachments"],
  providerEventReceiptId: string,
  organizationId: string,
  teamId: string,
  connectionId: string | null,
  executionId: string,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<AttachmentDescriptor[]> {
  if (source.length === 0) return [];
  if (attachments === undefined) throw new Error("attachment capability unavailable");
  if (connectionId === null) throw new Error("attachment ownership unavailable");
  const references = await Promise.all(
    source.map((file) =>
      attachments.register({
        providerEventReceiptId,
        organizationId,
        connectionId,
        provider: "mattermost",
        sourceId: file.id,
        locator: { teamId, fileId: file.id },
        filename: file.filename,
        contentType: file.contentType,
        byteSize: file.size,
      }),
    ),
  );
  return references.map((reference) => attachments.materialize(reference, executionId));
}

async function failWithNotice(
  client: MattermostBotClient,
  target: MattermostOutputContext,
  reason: string,
  reactionState?: TriggerProviderReactionState,
): Promise<void> {
  const port = reactionPort(client, target);
  await removeReactionForPhase(port, reactionState);
  await addReaction(port, REACTION_FAILED);
  await client.sendMessage({
    organizationId: target.organizationId,
    teamId: target.teamId,
    channelId: target.channelId,
    rootId: target.rootId,
    content: `Paseo agent failed: ${reason}`,
  });
}

export type { CompiledTriggerConfig };
