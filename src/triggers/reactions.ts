import { reportFailure } from "../failures/index.js";
import type { TriggerProviderReactionState } from "./index.js";

/**
 * The two phases every chat-provider reaction machine tracks. The state is stored as a plain
 * object in `TriggerProviderReactionState` so it survives serialisation across execution steps.
 */
export type ReactionPhase = "accepted" | "started";

/**
 * Reads the current reaction phase from an opaque `TriggerProviderReactionState`. Returns
 * `undefined` when the state is absent, not an object, or does not carry a recognised phase —
 * callers treat that the same as "no reaction has been posted yet".
 *
 * This is the only place that interprets the phase field. All three chat providers (Slack,
 * Discord, Mattermost) share the same phase semantics; only their emoji primitives differ.
 */
export function reactionPhase(
  state: TriggerProviderReactionState | undefined,
): ReactionPhase | undefined {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return undefined;
  const phase = (state as Record<string, unknown>)["phase"];
  return phase === "accepted" || phase === "started" ? phase : undefined;
}

/**
 * The provider-specific half of the machine: which emoji this provider uses, how it adds and
 * removes one, and what to say about it in a failure report.
 *
 * The state is persisted opaquely and replayed, so every hook below has to tolerate being called
 * twice with the same state. Keeping the phase-driven add/remove here is what stops three
 * providers from drifting into three subtly different answers to "which emoji is on the message".
 */
export interface ReactionPort {
  /** Names the failure reports, so an operator can tell which provider dropped a reaction. */
  provider: "slack" | "discord" | "mattermost";
  /** The two emoji that can be on the message while a run is in flight. */
  emoji: { accepted: string; started: string };
  add(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  diagnostic(name: string): Readonly<Record<string, unknown>>;
}

/** Adds a reaction, letting the caller decide what a failure means. */
export async function addReaction(port: ReactionPort, name: string): Promise<void> {
  await port.add(name);
}

/** Adds a reaction as a courtesy: a run must not fail because an emoji did not land. */
export async function addReactionSafely(port: ReactionPort, name: string): Promise<void> {
  try {
    await port.add(name);
  } catch (error) {
    reportFailure(
      error,
      {
        operation: `${port.provider}.reaction.add`,
        component: "triggers",
        provider: port.provider,
      },
      { diagnostic: port.diagnostic(name) },
    );
  }
}

/** Removes a reaction that may not be there; absence is the normal case, not an error. */
export async function removeReactionSafely(port: ReactionPort, name: string): Promise<void> {
  try {
    await port.remove(name);
  } catch (error) {
    reportFailure(
      error,
      {
        operation: `${port.provider}.reaction.cleanup`,
        component: "triggers",
        provider: port.provider,
      },
      { diagnostic: port.diagnostic(name) },
    );
  }
}

/**
 * Clears whichever in-flight emoji the phase says is on the message. With no usable phase it
 * clears both, because leaving a stale ⏳ on a finished run is worse than one redundant call.
 */
export async function removeReactionForPhase(
  port: ReactionPort,
  reactionState: TriggerProviderReactionState | undefined,
  fallbackPhase?: ReactionPhase,
): Promise<void> {
  const phase = reactionPhase(reactionState) ?? fallbackPhase;
  if (phase === "accepted") {
    await removeReactionSafely(port, port.emoji.accepted);
    return;
  }
  if (phase === "started") {
    await removeReactionSafely(port, port.emoji.started);
    return;
  }
  await removeReactionSafely(port, port.emoji.accepted);
  await removeReactionSafely(port, port.emoji.started);
}

/** Removes then adds, so the message never carries both in-flight emoji at once. */
export async function replaceReaction(port: ReactionPort, from: string, to: string): Promise<void> {
  await removeReactionSafely(port, from);
  await addReactionSafely(port, to);
}
