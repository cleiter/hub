import { z } from "zod";

/**
 * The three GitLab hooks Hub accepts, keyed by the `X-Gitlab-Event` header value GitLab sends.
 * Anything else is acknowledged and dropped rather than refused: a webhook configured with extra
 * event types is a configuration choice on GitLab's side, not an error on ours.
 */
export const GITLAB_EVENT_KINDS: ReadonlyMap<string, GitLabEventKind> = new Map(
  Object.entries({
    "Merge Request Hook": "merge_request",
    "Issue Hook": "issue",
    "Note Hook": "note",
  } satisfies Record<string, GitLabEventKind>),
);

export type GitLabEventKind = "merge_request" | "issue" | "note";

/**
 * Every schema here is permissive by design. Hub supports self-managed instances across several
 * GitLab releases, and payload shapes gain and lose optional fields between them. Only the fields
 * actually consumed are required; everything else passes through untouched, so an older or newer
 * instance is not rejected for sending a payload that differs from the current documentation.
 */
const GitLabUserSchema = z
  .object({ id: z.number().optional(), username: z.string().min(1) })
  .passthrough();

const GitLabProjectSchema = z
  .object({
    id: z.number(),
    path_with_namespace: z.string().min(1),
    web_url: z.string().optional(),
  })
  .passthrough();

const GitLabNoteableSchema = z
  .object({
    iid: z.number().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
  })
  .passthrough();

const GitLabObjectAttributesSchema = z
  .object({
    iid: z.number().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    note: z.string().optional(),
    url: z.string().optional(),
    action: z.string().optional(),
    noteable_type: z.string().optional(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
  })
  .passthrough();

export const GitLabWebhookPayloadSchema = z
  .object({
    object_kind: z.string().min(1),
    user: GitLabUserSchema,
    project: GitLabProjectSchema,
    object_attributes: GitLabObjectAttributesSchema,
    merge_request: GitLabNoteableSchema.optional(),
    issue: GitLabNoteableSchema.optional(),
  })
  .passthrough();

export type GitLabWebhookPayload = z.infer<typeof GitLabWebhookPayloadSchema>;

export const NormalizedGitLabEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["merge_request", "issue", "note"]),
  connectionId: z.string().min(1),
  project: z.object({
    id: z.number(),
    pathWithNamespace: z.string().min(1),
    webUrl: z.string().nullable(),
  }),
  actor: z.object({ id: z.number().nullable(), username: z.string().min(1) }),
  item: z.object({
    type: z.enum(["merge_request", "issue", "note"]),
    iid: z.number().nullable(),
    title: z.string().nullable(),
    body: z.string(),
    url: z.string().nullable(),
    action: z.string(),
    sourceBranch: z.string().nullable(),
    targetBranch: z.string().nullable(),
    noteableType: z.string().nullable(),
  }),
  receivedAt: z.string(),
  payload: z.unknown(),
});

export type NormalizedGitLabEvent = z.infer<typeof NormalizedGitLabEventSchema>;

/**
 * The text a trigger's `pattern`/`contains` filter and the invocation parser read. A comment is
 * invoked by its own text; a merge request or issue by its description, which is what an author
 * writes when opening one.
 */
function readInvocationText(kind: GitLabEventKind, payload: GitLabWebhookPayload): string {
  return (
    (kind === "note" ? payload.object_attributes.note : payload.object_attributes.description) ?? ""
  );
}

/**
 * GitLab reports what a comment is attached to in PascalCase (`MergeRequest`, `Issue`, `Commit`,
 * `Snippet`). Trigger filters are authored in snake_case like every other Hub filter value, so the
 * two are reconciled here rather than in each author's YAML.
 */
export function normalizeNoteableType(noteableType: string | undefined): string | null {
  if (noteableType === undefined || noteableType.length === 0) return null;
  return noteableType
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[\s-]+/gu, "_")
    .toLowerCase();
}

export function normalizeGitLabEvent(input: {
  kind: GitLabEventKind;
  deliveryId: string;
  connectionId: string;
  payload: unknown;
  receivedAt: Date;
}): NormalizedGitLabEvent | undefined {
  const parsed = GitLabWebhookPayloadSchema.safeParse(input.payload);
  if (!parsed.success) return undefined;
  const payload = parsed.data;
  // The header and the body must agree. They disagreeing means the delivery is not what it claims,
  // and guessing which one to believe would turn a clear error into a confusing mis-parse.
  if (payload.object_kind !== input.kind) return undefined;

  return {
    id: input.deliveryId,
    type: input.kind,
    connectionId: input.connectionId,
    project: {
      id: payload.project.id,
      pathWithNamespace: payload.project.path_with_namespace,
      webUrl: payload.project.web_url ?? null,
    },
    actor: { id: payload.user.id ?? null, username: payload.user.username },
    item: normalizeItem(input.kind, payload),
    receivedAt: input.receivedAt.toISOString(),
    payload,
  };
}

/**
 * A comment reports the merge request or issue it is attached to alongside its own attributes, and
 * the subject's identifiers are the useful ones — a workflow reacting to a comment wants the merge
 * request's number, not the note's.
 */
function normalizeItem(
  kind: GitLabEventKind,
  payload: GitLabWebhookPayload,
): NormalizedGitLabEvent["item"] {
  const attributes = payload.object_attributes;
  const subject = kind === "note" ? (payload.merge_request ?? payload.issue) : undefined;
  return {
    type: kind,
    iid: subject?.iid ?? attributes.iid ?? null,
    title: subject?.title ?? attributes.title ?? null,
    body: readInvocationText(kind, payload),
    url: attributes.url ?? subject?.url ?? null,
    // A comment carries no action of its own; treating it as a creation is what the event is.
    action: attributes.action ?? (kind === "note" ? "create" : "unknown"),
    sourceBranch: attributes.source_branch ?? subject?.source_branch ?? null,
    targetBranch: attributes.target_branch ?? subject?.target_branch ?? null,
    noteableType: normalizeNoteableType(attributes.noteable_type),
  };
}
