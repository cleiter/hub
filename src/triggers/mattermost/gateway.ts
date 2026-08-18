import type { ProviderEventAcceptance } from "../../db/types.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import { logProviderEventIntake } from "../audit.js";
import { reportFailure } from "../../failures/index.js";
import type { MattermostBot } from "./bot.js";
import { isMattermostTriggerCandidate, normalizeMattermostEvent } from "./events.js";

export interface CreateMattermostGatewaySourceOptions {
  bot: MattermostBot;
  accept(input: {
    teamId: string;
    deliveryId: string;
    source: string;
    payload: unknown;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
}

export function createMattermostGatewaySource(
  options: CreateMattermostGatewaySourceOptions,
): TriggerSource {
  const handlers = new Set<TriggerHandler>();
  let unsubscribe: (() => void) | undefined;

  return {
    async start(handler) {
      handlers.add(handler);
      if (unsubscribe !== undefined) return;
      await options.bot.start();
      unsubscribe = options.bot.onFrame(async (frame) => {
        await dispatchFrame(frame, handlers, options);
      });
    },
    async stop() {
      handlers.clear();
      unsubscribe?.();
      unsubscribe = undefined;
      await options.bot.stop();
    },
  };
}

async function dispatchFrame(
  frame: unknown,
  handlers: Set<TriggerHandler>,
  options: CreateMattermostGatewaySourceOptions,
): Promise<void> {
  const botUserId = options.bot.getSelfUserId();
  if (botUserId === undefined) return;

  // Order matters. The gateway sees every frame for every channel the bot is in — typing
  // indicators, presence changes, reads, and ordinary chatter — and almost none of it is a
  // trigger. The candidate test is a handful of property reads on the raw frame and never
  // touches `data.post`, so the discard path stays cheap.
  //
  // Discord does the opposite (discord/gateway.ts:78,106,111,115): it fully validates every
  // message, then applies the cheap check, then validates a second time. That is two zod parses
  // per message for traffic that is thrown away. Do not copy that shape here.
  if (!isMattermostTriggerCandidate(frame, botUserId)) return;

  const event = normalizeMattermostEvent(frame, botUserId);
  if (event === undefined) return;

  // The permalink parts the frame does not carry; see NormalizedMattermostMentionEventSchema.
  const teamName = options.bot.getTeamName(event.teamId);
  const payload = {
    ...event,
    serverUrl: options.bot.serverOrigin(),
    ...(teamName === undefined ? {} : { teamName }),
  };

  const deliveryId = `mattermost-${event.postId}`;
  try {
    const acceptance = await options.accept({
      teamId: event.teamId,
      deliveryId,
      source: "mattermost.mention",
      payload,
      receivedAt: new Date(event.createAt),
      ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" } : {}),
    });
    logProviderEventIntake({
      provider: "mattermost",
      source: "mattermost.mention",
      deliveryId,
      resourceId: event.teamId,
      acceptance,
    });
    const events = acceptance.status === "accepted" ? acceptance.events : [];
    await Promise.all(
      events.flatMap((accepted) => Array.from(handlers, (handler) => handler(accepted))),
    );
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "mattermost.gateway.handoff",
        component: "triggers",
        provider: "mattermost",
      },
      { diagnostic: { teamId: event.teamId, deliveryId } },
    );
  }
}
