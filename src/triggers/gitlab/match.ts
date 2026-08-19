import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type { GitLabEventKind, NormalizedGitLabEvent } from "./events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedGitLabTrigger {
  event: NormalizedGitLabEvent;
  trigger: MatchedTriggerDefinition;
}

/**
 * Defaults are deliberately narrow. GitLab sends a merge-request hook for every label change,
 * description edit, assignee change and approval; without a default the common trigger would burn
 * an agent run on each of them. Reacting to an edit has to be asked for by name.
 */
const DEFAULT_ACTIONS: Readonly<Record<GitLabEventKind, readonly string[]>> = {
  merge_request: ["open", "reopen", "merge"],
  // Issues have no merge action, so listing one would only be noise.
  issue: ["open", "reopen"],
  // A comment carries no action of its own; normalization reports every one as a creation.
  note: ["create"],
};

/**
 * Comments on commits and snippets arrive on the same Note hook as comments on merge requests and
 * issues. Accepting them by default would fire a merge-request workflow from a commit comment that
 * has no merge request at all.
 */
const DEFAULT_NOTEABLES: readonly string[] = ["merge_request", "issue"];

export function matchGitLabTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedGitLabEvent,
  connectionId?: string | null,
): MatchedGitLabTrigger[] {
  const expectedEventName = `gitlab.${event.type}`;
  return config.triggers
    .filter(
      (trigger) =>
        trigger.on === expectedEventName && matchesFilter(event, trigger.filters, connectionId),
    )
    .map((trigger) => ({ event, trigger }));
}

function matchesFilter(
  event: NormalizedGitLabEvent,
  filter: TriggerFilter | undefined,
  connectionId?: string | null,
): boolean {
  // An absent filter block means no actor allowlist, which compilation already refuses for
  // externally sourced triggers. Refusing here too keeps the matcher safe on its own.
  if (filter === undefined) return false;
  if (filter.from_users === undefined || filter.from_users.length === 0) return false;
  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) return false;

  const project = readStringFilter(filter, "project");
  if (project !== undefined && project !== event.project.pathWithNamespace) return false;

  const actions = readStringArrayFilter(filter, "actions") ?? DEFAULT_ACTIONS[event.type];
  if (!actions.includes(event.item.action)) return false;

  if (event.type === "note") {
    const noteables = readStringArrayFilter(filter, "noteable") ?? DEFAULT_NOTEABLES;
    // A comment whose target GitLab did not report cannot be shown to satisfy the filter.
    if (event.item.noteableType === null || !noteables.includes(event.item.noteableType)) {
      return false;
    }
  }

  if (
    !filter.from_users.includes(event.actor.username) &&
    (event.actor.id === null || !filter.from_users.includes(String(event.actor.id)))
  ) {
    return false;
  }

  return matchesPattern(event, readPatternFilter(filter));
}

/**
 * The pattern has to sit at the start of the text and end on a word boundary, so `/review` does not
 * match `/reviewers` and a mention of the pattern midway through a description does not launch a
 * run. This is the same rule the Discord and Slack matchers apply to the text after the bot
 * mention.
 */
function matchesPattern(event: NormalizedGitLabEvent, pattern: string | undefined): boolean {
  if (pattern === undefined || pattern.length === 0) return true;
  const body = readGitLabPromptBody(event);
  if (!body.startsWith(pattern)) return false;
  const nextCharacter = body.at(pattern.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter);
}

export function readGitLabPromptBody(event: NormalizedGitLabEvent): string {
  return event.item.body;
}

/** The prompt with a leading command marker removed, so the agent reads the request, not the verb. */
export function readGitLabInvocationParserMessage(
  event: NormalizedGitLabEvent,
  filter: TriggerFilter | undefined,
): string {
  const body = readGitLabPromptBody(event);
  const marker = filter === undefined ? undefined : readPatternFilter(filter);
  if (
    marker === undefined ||
    marker.length === 0 ||
    marker.includes("=") ||
    !body.startsWith(marker)
  ) {
    return body;
  }
  const nextCharacter = body.at(marker.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter)
    ? body.slice(marker.length).trimStart()
    : body;
}

function readPatternFilter(filter: TriggerFilter): string | undefined {
  return readStringFilter(filter, "pattern") ?? readStringFilter(filter, "contains");
}

function readStringFilter(
  filter: TriggerFilter,
  key: "project" | "pattern" | "contains",
): string | undefined {
  const value = filter[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArrayFilter(
  filter: TriggerFilter,
  key: "actions" | "noteable",
): string[] | undefined {
  const value = filter[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}
