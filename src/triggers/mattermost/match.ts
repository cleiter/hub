import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type { NormalizedMattermostMentionEvent } from "./events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedMattermostTrigger {
  event: NormalizedMattermostMentionEvent;
  trigger: MatchedTriggerDefinition;
}

export function matchMattermostTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedMattermostMentionEvent,
  botUserId: string,
  botUsername: string,
  connectionId?: string | null,
): MatchedMattermostTrigger[] {
  if (event.author.id === botUserId) return [];
  return config.triggers.flatMap((trigger) => {
    return trigger.on === "mattermost.mention" &&
      matchesFilters(event, trigger.filters, botUsername, connectionId)
      ? [{ event, trigger }]
      : [];
  });
}

function matchesFilters(
  event: NormalizedMattermostMentionEvent,
  filters: TriggerFilter | undefined,
  botUsername: string,
  connectionId?: string | null,
): boolean {
  if (filters === undefined || !mentionsBot(event.content, botUsername)) return false;
  if (
    filters.from_users === undefined ||
    (!filters.from_users.includes(event.author.id) &&
      (event.author.username === undefined || !filters.from_users.includes(event.author.username)))
  )
    return false;
  if (filters.connectionId !== undefined && filters.connectionId !== connectionId) return false;
  const team = readString(filters, "team");
  if (team !== undefined && team !== event.teamId) return false;
  const channels = readStrings(filters, "channels");
  if (channels !== undefined && !channels.includes(event.channelId)) return false;
  const pattern = readString(filters, "pattern") ?? readString(filters, "contains");
  if (pattern === undefined || pattern.length === 0) return true;
  const body = readMattermostPromptBody(event, botUsername);
  if (!body.startsWith(pattern)) return false;
  const nextCharacter = body.at(pattern.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter);
}

/**
 * Requires an explicit `@botusername` token in the message text.
 *
 * Deliberately NOT `event.mentionedUserIds.includes(botUserId)`: Mattermost adds the bot to
 * `data.mentions` for `@channel`, `@all` and `@here` as well, so trusting that alone makes the
 * bot fire on every broadcast announcement (recorded in fixtures/mentions-probe.json).
 *
 * The boundary check keeps `@paseobot` from matching a post addressed to `@paseobotter`.
 * Mattermost usernames allow letters, numbers, and `.-_`, so those characters continue a name;
 * anything else terminates it.
 */
export function mentionsBot(content: string, botUsername: string): boolean {
  if (botUsername.length === 0) return false;
  const token = `@${botUsername}`;
  let index = content.indexOf(token);
  while (index >= 0) {
    if (isMentionBoundary(content, index, token.length)) return true;
    index = content.indexOf(token, index + 1);
  }
  return false;
}

function isMentionBoundary(content: string, index: number, length: number): boolean {
  // A `@` immediately preceded by a username character is part of something else, such as the
  // local part of an email address.
  const before = index === 0 ? undefined : content.at(index - 1);
  if (before !== undefined && /[A-Za-z0-9._-]/u.test(before)) return false;
  const after = content.at(index + length);
  return after === undefined || !/[A-Za-z0-9._-]/u.test(after);
}

export function readMattermostPromptBody(
  event: NormalizedMattermostMentionEvent,
  botUsername: string,
): string {
  const token = `@${botUsername}`;
  let index = event.content.indexOf(token);
  while (index >= 0) {
    if (isMentionBoundary(event.content, index, token.length)) {
      return event.content.slice(index + token.length).trimStart();
    }
    index = event.content.indexOf(token, index + 1);
  }
  return event.content;
}

export function readMattermostInvocationParserMessage(
  event: NormalizedMattermostMentionEvent,
  botUsername: string,
  filters: TriggerFilter | undefined,
): string {
  const body = readMattermostPromptBody(event, botUsername);
  const marker = filters === undefined ? undefined : readPatternMarker(filters);
  if (
    marker === undefined ||
    marker.length === 0 ||
    marker.includes("=") ||
    !body.startsWith(marker)
  )
    return body;
  const nextCharacter = body.at(marker.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter)
    ? body.slice(marker.length).trimStart()
    : body;
}

function readPatternMarker(filters: TriggerFilter): string | undefined {
  return readString(filters, "pattern") ?? readString(filters, "contains");
}

function readString(
  filters: TriggerFilter,
  key: "team" | "pattern" | "contains",
): string | undefined {
  const value = filters[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStrings(filters: TriggerFilter, key: "channels"): string[] | undefined {
  const value = filters[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;
}
