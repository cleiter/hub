import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentDescriptor,
} from "../../attachments/capabilities.js";
import { type TriggerProvider, type TriggerProviderMatch } from "../index.js";
import type { DiscordBotClient } from "./bot.js";
import {
  matchDiscordTriggers,
  readDiscordInvocationParserMessage,
  readDiscordPromptBody,
} from "./match.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import {
  addReaction,
  addReactionSafely,
  reactionPhase,
  removeReactionForPhase,
  replaceReaction,
  type ReactionPort,
} from "../reactions.js";
import { NormalizedDiscordMessageEventSchema } from "./events.js";
import type { NormalizedDiscordContextMessage, NormalizedDiscordMessageEvent } from "./events.js";

export interface DiscordAttachmentLocator {
  id: string;
  filename: string;
  contentType: string | null;
  size: number;
}

export interface DiscordMergeMessage {
  id: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  channel: { id: string };
  created_at: string;
  attachments: DiscordAttachmentLocator[];
  referenced_message: { id: string; channel_id: string; guild_id: string | null } | null;
}

export interface DiscordMaterializedMessage {
  id: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  channel: { id: string };
  created_at: string;
  attachments: AttachmentDescriptor[];
  referenced_message: { id: string; channel_id: string; guild_id: string | null } | null;
}

export interface DiscordMaterializedContext {
  discord: {
    referenced_message: DiscordMaterializedMessage | null;
    thread: {
      id: string;
      parent_channel_id: string | null;
      context_url: string;
      messages: DiscordMaterializedMessage[];
    } | null;
  };
}

export interface DiscordMergeData {
  discord: {
    event_type: "mention";
    connection_id: string | null;
    guild: { id: string };
    trigger_message: DiscordMergeMessage & {
      body: string;
      url: string;
      thread: { id: string; parent_channel_id: string | null; context_url: string } | null;
    };
    trigger_thread_context: { status: "deferred" | "not_applicable" };
  };
}

export interface DiscordTriggerContext {
  provider: "discord";
  target: DiscordOutputContext;
  event: DiscordMergeData;
}

export interface DiscordOutputContext {
  provider: "discord";
  guildId: string;
  channelId: string;
  threadId: string | null;
  messageId: string;
}

export function createDiscordTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  bot: DiscordBotClient;
  attachments?: AttachmentCapabilityRegistry;
}): TriggerProvider<
  "discord",
  DiscordTriggerContext,
  DiscordOutputContext,
  DiscordMaterializedContext
> {
  return {
    name: "discord",
    eventNames: ["discord.mention"],
    async match(externalTrigger) {
      const event = NormalizedDiscordMessageEventSchema.parse(externalTrigger.payload);
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (
        !stored.configuration.triggers.some((candidate) => candidate.on === externalTrigger.source)
      )
        return "no_trigger_for_source";
      const botClientId = options.bot.getSelfUserId();
      const matches: TriggerProviderMatch<DiscordTriggerContext, DiscordOutputContext>[] = [];

      for (const match of matchDiscordTriggers(
        stored.configuration,
        event,
        botClientId,
        externalTrigger.connectionId,
      )) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiledTrigger === undefined)
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
        const outputContext: DiscordOutputContext = {
          provider: "discord",
          guildId: event.guildId,
          channelId: event.channelId,
          threadId: event.threadId,
          messageId: event.messageId,
        };
        const triggerContext: DiscordTriggerContext = {
          provider: "discord",
          target: outputContext,
          event: buildDiscordMergeData(event, botClientId, externalTrigger.connectionId),
        };
        const invocation = parseInvocation(
          event.content,
          compiledTrigger.inputs,
          undefined,
          readDiscordInvocationParserMessage(event, botClientId, compiledTrigger.filters),
        );
        if (invocation.status === "accepted") {
          if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
        }
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
    async materializeContext(launch) {
      const event = launch.triggerContext.event.discord;
      const messages =
        event.trigger_message.thread === null
          ? []
          : await options.bot.readThreadMessages({
              channelId: event.trigger_message.thread.id,
              beforeMessageId: event.trigger_message.id,
            });
      const contextMessages = await Promise.all(
        messages.map((message) =>
          materializeDiscordMessage(
            message,
            launch.providerEventReceiptId,
            launch.organizationId,
            launch.triggerContext.event.discord.connection_id,
            launch.executionId,
            options.attachments,
          ),
        ),
      );
      const referencedMessage = await materializeReferencedMessage(
        event.trigger_message.referenced_message,
        messages,
        contextMessages,
        launch,
        options.bot,
        options.attachments,
        event.connection_id,
      );
      return {
        discord: {
          referenced_message: referencedMessage,
          thread:
            event.trigger_message.thread === null
              ? null
              : { ...event.trigger_message.thread, messages: contextMessages },
        },
      };
    },
    async onDispatchAccepted(triggerContext, _outputContext, reactionState) {
      if (reactionPhase(reactionState) !== undefined) return reactionState;
      await addReactionSafely(reactionPort(options.bot, triggerContext.target), "eyes");
      return { phase: "accepted" };
    },
    async onAgentExecutionStarted(triggerContext, _outputContext, reactionState) {
      if (reactionPhase(reactionState) === "started") return reactionState;
      await replaceReaction(reactionPort(options.bot, triggerContext.target), "eyes", "hourglass");
      return { phase: "started" };
    },
    async onAgentExecutionCompleted(triggerContext, _outputContext, _result, reactionState) {
      const port = reactionPort(options.bot, triggerContext.target);
      await removeReactionForPhase(port, reactionState, "started");
      await addReaction(port, "white_check_mark");
      return null;
    },
    async onAgentExecutionFailed(triggerContext, _outputContext, reason, reactionState) {
      const port = reactionPort(options.bot, triggerContext.target);
      await removeReactionForPhase(port, reactionState);
      await addReaction(port, "x");
      await postThreadNotice(options.bot, triggerContext.target, `Paseo agent failed: ${reason}`);
      return null;
    },
    async onMachineTerminated(triggerContext, reason, reactionState) {
      if (reason === "launch_failed" || reason === "daemon_disconnected") {
        const port = reactionPort(options.bot, triggerContext.target);
        await removeReactionForPhase(port, reactionState);
        await addReaction(port, "x");
        await postThreadNotice(
          options.bot,
          triggerContext.target,
          `Paseo machine terminated before the agent could complete: ${reason}`,
        );
        return null;
      }
      return reactionState;
    },
  };
}

async function materializeReferencedMessage(
  reference: DiscordMergeMessage["referenced_message"],
  sourceMessages: NormalizedDiscordContextMessage[],
  materializedMessages: DiscordMaterializedMessage[],
  launch: {
    executionId: string;
    organizationId: string;
    providerEventReceiptId: string;
  },
  bot: DiscordBotClient,
  attachments: AttachmentCapabilityRegistry | undefined,
  connectionId: string | null,
): Promise<DiscordMaterializedMessage | null> {
  if (reference === null) return null;
  const existingIndex = sourceMessages.findIndex(
    (message) => message.id === reference.id && message.channelId === reference.channel_id,
  );
  if (existingIndex !== -1) return materializedMessages[existingIndex]!;

  const message = await bot.readMessage({
    channelId: reference.channel_id,
    messageId: reference.id,
  });
  return materializeDiscordMessage(
    message,
    launch.providerEventReceiptId,
    launch.organizationId,
    connectionId,
    launch.executionId,
    attachments,
  );
}

/**
 * Binds the shared reaction machine to one Discord message. Discord takes literal emoji rather
 * than names, so the translation happens here and the failure diagnostic reports the translated
 * value — that is what an operator would see in the Discord API log.
 */
function reactionPort(bot: DiscordBotClient, event: DiscordOutputContext): ReactionPort {
  const scope = { channelId: event.channelId, messageId: event.messageId };
  return {
    provider: "discord",
    emoji: { accepted: "eyes", started: "hourglass" },
    add: (name) => bot.createReaction({ ...scope, emoji: toDiscordReactionEmoji(name) }),
    remove: (name) => bot.deleteOwnReaction({ ...scope, emoji: toDiscordReactionEmoji(name) }),
    diagnostic: (name) => ({ ...scope, emoji: toDiscordReactionEmoji(name) }),
  };
}

function buildDiscordMergeData(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
  connectionId: string | null | undefined,
): DiscordMergeData {
  return {
    discord: {
      event_type: event.type,
      connection_id: connectionId ?? null,
      guild: { id: event.guildId },
      trigger_message: {
        ...buildDiscordMergeMessage(event),
        attachments: event.attachments.map(toAttachmentLocator),
        body: readDiscordPromptBody(event, botClientId),
        url: buildDiscordMessageUrl(event),
        thread:
          event.threadId === null
            ? null
            : {
                id: event.threadId,
                parent_channel_id: event.parentChannelId,
                context_url: buildDiscordContextUrl(event),
              },
      },
      trigger_thread_context: { status: event.threadId === null ? "not_applicable" : "deferred" },
    },
  };
}

function buildDiscordMergeMessage(
  message:
    | (Pick<
        NormalizedDiscordMessageEvent,
        "id" | "content" | "author" | "createdAt" | "referencedMessage"
      > & {
        channelId: string;
      })
    | NormalizedDiscordContextMessage,
): Omit<DiscordMergeMessage, "attachments"> {
  return {
    id: message.id,
    content: message.content,
    author: {
      id: message.author.id,
      username: message.author.username,
      ...(message.author.bot === undefined ? {} : { bot: message.author.bot }),
    },
    channel: { id: message.channelId },
    created_at: message.createdAt,
    referenced_message:
      message.referencedMessage === null
        ? null
        : {
            id: message.referencedMessage.id,
            channel_id: message.referencedMessage.channelId,
            guild_id: message.referencedMessage.guildId,
          },
  };
}

async function registerAttachments(
  source: NormalizedDiscordContextMessage["attachments"],
  providerEventReceiptId: string,
  organizationId: string,
  connectionId: string | null,
  executionId: string,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<AttachmentDescriptor[]> {
  if (source.length === 0) return [];
  if (attachments === undefined) throw new Error("attachment capability unavailable");
  if (connectionId === null) {
    throw new Error("attachment ownership unavailable");
  }
  const references = await Promise.all(
    source.map((file) =>
      attachments.register({
        providerEventReceiptId,
        organizationId,
        connectionId,
        provider: "discord",
        sourceId: file.id,
        locator: { url: file.url },
        filename: file.filename,
        contentType: file.contentType,
        byteSize: file.size,
      }),
    ),
  );
  return references.map((reference) => attachments.materialize(reference, executionId));
}

async function materializeDiscordMessage(
  message: NormalizedDiscordContextMessage,
  providerEventReceiptId: string,
  organizationId: string,
  connectionId: string | null,
  executionId: string,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<DiscordMaterializedMessage> {
  const materializedAttachments = await registerAttachments(
    message.attachments,
    providerEventReceiptId,
    organizationId,
    connectionId,
    executionId,
    attachments,
  );
  return Object.assign(buildDiscordMergeMessage(message), {
    attachments: materializedAttachments,
  });
}

function toAttachmentLocator(
  attachment: NormalizedDiscordMessageEvent["attachments"][number],
): DiscordAttachmentLocator {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
  };
}

function buildDiscordMessageUrl(event: NormalizedDiscordMessageEvent): string {
  return `https://discord.com/channels/${event.guildId}/${event.channelId}/${event.messageId}`;
}

function buildDiscordContextUrl(event: NormalizedDiscordMessageEvent): string {
  return `https://discord.com/channels/${event.guildId}/${event.threadId ?? event.channelId}`;
}

function toDiscordReactionEmoji(emoji: string): string {
  switch (emoji) {
    case "eyes":
      return "👀";
    case "hourglass":
      return "⏳";
    case "check":
    case "white_check_mark":
      return "✅";
    case "cross":
    case "x":
      return "❌";
    default:
      return emoji;
  }
}

async function postThreadNotice(
  bot: DiscordBotClient,
  event: DiscordOutputContext,
  content: string,
): Promise<void> {
  await bot.sendChannelMessage({
    channelId: event.channelId,
    threadId: event.threadId,
    content,
  });
}
