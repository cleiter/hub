import { z } from "zod";

// Every schema here is derived from recordings in ./fixtures (Mattermost 11.10.0), not from
// documentation. See fixtures/README.md for the table of what the recordings settled.

const MattermostIdSchema = z.string().min(1).max(255);

/** `O` public, `P` private, `D` direct message, `G` group message. */
export const MATTERMOST_CHANNEL_TYPES = ["O", "P", "D", "G"] as const;

const MattermostFileInfoSchema = z
  .object({
    id: MattermostIdSchema,
    name: z.string().min(1).max(255).optional(),
    extension: z.string().max(255).optional(),
    size: z.number().int().nonnegative().optional(),
    mime_type: z.string().max(255).optional(),
  })
  .passthrough();

/** The object encoded inside `data.post`. `data.post` is a JSON *string*, never an object. */
export const MattermostPostSchema = z
  .object({
    id: MattermostIdSchema,
    create_at: z.number().int().nonnegative(),
    user_id: MattermostIdSchema,
    channel_id: MattermostIdSchema,
    // Root posts carry the empty string here, not null.
    root_id: z.string().default(""),
    message: z.string().default(""),
    // System messages (joins, header changes) use `system_*`; ordinary posts use "".
    type: z.string().default(""),
    file_ids: z.array(MattermostIdSchema).optional(),
    metadata: z
      .object({ files: z.array(MattermostFileInfoSchema).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const MattermostPostedDataSchema = z
  .object({
    post: z.string().min(1),
    channel_type: z.string().min(1).max(8),
    channel_name: z.string().optional(),
    channel_display_name: z.string().optional(),
    // Empty string for direct and group messages — they belong to no team.
    team_id: z.string().default(""),
    // `@`-prefixed, e.g. "@admin". Absent on some system events.
    sender_name: z.string().optional(),
    // JSON-encoded array of user ids. The key is ABSENT when nobody was mentioned.
    mentions: z.string().optional(),
  })
  .passthrough();

export const MattermostEnvelopeSchema = z
  .object({
    event: z.string().min(1),
    data: z.unknown(),
    broadcast: z
      .object({
        // Always the empty string in practice — the team lives on `data`, not here.
        team_id: z.string().optional(),
        channel_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
    seq: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const MattermostAttachmentMetadataSchema = z.object({
  id: MattermostIdSchema,
  filename: z.string().min(1).max(255),
  contentType: z.string().max(255).nullable(),
  size: z.number().int().nonnegative().nullable(),
});

export const NormalizedMattermostMentionEventSchema = z.object({
  type: z.literal("mention"),
  id: MattermostIdSchema,
  teamId: MattermostIdSchema,
  channelId: MattermostIdSchema,
  channelType: z.enum(MATTERMOST_CHANNEL_TYPES),
  postId: MattermostIdSchema,
  rootId: MattermostIdSchema.nullable(),
  createAt: z.number().int().nonnegative(),
  content: z.string(),
  author: z.object({ id: MattermostIdSchema, username: z.string().min(1).max(255).optional() }),
  mentionedUserIds: z.array(MattermostIdSchema).default([]),
  createdAt: z.string(),
  attachments: z.array(MattermostAttachmentMetadataSchema).default([]),
  /**
   * Neither field is in the websocket frame. The gateway adds them from the bot's own
   * configuration so the activity feed can link back to the post — a permalink is
   * `<server>/<team name>/pl/<post id>`, and the frame carries only the team *id*.
   */
  serverUrl: z.string().optional(),
  teamName: z.string().min(1).optional(),
});

export type NormalizedMattermostMentionEvent = z.infer<
  typeof NormalizedMattermostMentionEventSchema
>;

/**
 * Cheap candidate test run on the RAW websocket frame before any schema validation.
 *
 * Ordering matters: Discord validates every message and only then checks whether it is even a
 * candidate (`discord/gateway.ts:78,106,111,115`), paying two full zod parses for traffic it
 * discards. Here the discard path costs a couple of property reads.
 *
 * This is deliberately permissive — it only has to be cheap and never reject a real mention.
 * `matchMattermostTriggers` applies the precise test, which matters because Mattermost puts the
 * bot into `data.mentions` for `@channel`, `@all` and `@here` too (see fixtures/mentions-probe.json).
 */
export function isMattermostTriggerCandidate(frame: unknown, botUserId: string): boolean {
  if (typeof frame !== "object" || frame === null) return false;
  const envelope = frame as { event?: unknown; data?: unknown };
  if (envelope.event !== "posted") return false;
  if (typeof envelope.data !== "object" || envelope.data === null) return false;
  const data = envelope.data as { team_id?: unknown; mentions?: unknown; post?: unknown };
  if (typeof data.post !== "string") return false;
  // Direct and group messages carry an empty team id and cannot be routed to a bound team.
  if (typeof data.team_id !== "string" || data.team_id.length === 0) return false;
  // Absent whenever nobody was mentioned, which is the overwhelming majority of traffic.
  return typeof data.mentions === "string" && data.mentions.includes(botUserId);
}

export function normalizeMattermostEvent(
  frame: unknown,
  botUserId: string,
): NormalizedMattermostMentionEvent | undefined {
  const envelope = MattermostEnvelopeSchema.safeParse(frame);
  if (!envelope.success || envelope.data.event !== "posted") return undefined;
  const data = MattermostPostedDataSchema.safeParse(envelope.data.data);
  if (!data.success) return undefined;

  const channelType = data.data.channel_type;
  if (!isChannelType(channelType)) return undefined;
  // Direct ("D") and group ("G") messages have no team, and every routing path downstream is
  // keyed on a bound team. Dropping them here mirrors discord/gateway.ts:59.
  if (channelType === "D" || channelType === "G") return undefined;
  if (data.data.team_id.length === 0) return undefined;

  let parsedPost: unknown;
  try {
    parsedPost = JSON.parse(data.data.post);
  } catch {
    return undefined;
  }
  const post = MattermostPostSchema.safeParse(parsedPost);
  if (!post.success) return undefined;
  // Joins, leaves, header changes, and similar are never agent triggers.
  if (post.data.type.startsWith("system_")) return undefined;
  // Never react to our own posts.
  if (post.data.user_id === botUserId) return undefined;

  const mentionedUserIds = parseMentions(data.data.mentions);
  const files = post.data.metadata?.files ?? [];

  return NormalizedMattermostMentionEventSchema.parse({
    type: "mention",
    id: post.data.id,
    teamId: data.data.team_id,
    channelId: post.data.channel_id,
    channelType,
    postId: post.data.id,
    rootId: post.data.root_id.length === 0 ? null : post.data.root_id,
    createAt: post.data.create_at,
    content: post.data.message,
    author: {
      id: post.data.user_id,
      ...(readSenderUsername(data.data.sender_name) === undefined
        ? {}
        : { username: readSenderUsername(data.data.sender_name) }),
    },
    mentionedUserIds,
    createdAt: new Date(post.data.create_at).toISOString(),
    attachments: files.map((file) => ({
      id: file.id,
      filename: file.name ?? file.id,
      contentType: file.mime_type ?? null,
      size: file.size ?? null,
    })),
  });
}

/** `sender_name` arrives `@`-prefixed. Strip it so it can be compared to `from_users` entries. */
function readSenderUsername(senderName: string | undefined): string | undefined {
  if (senderName === undefined) return undefined;
  const username = senderName.startsWith("@") ? senderName.slice(1) : senderName;
  return username.length === 0 ? undefined : username;
}

function parseMentions(mentions: string | undefined): string[] {
  if (mentions === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(mentions);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function isChannelType(value: string): value is (typeof MATTERMOST_CHANNEL_TYPES)[number] {
  return MATTERMOST_CHANNEL_TYPES.some((candidate) => candidate === value);
}
