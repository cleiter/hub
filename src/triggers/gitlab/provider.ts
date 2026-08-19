import type { ProjectConfigurationStore } from "../../configuration/store.js";
import { type TriggerProvider, type TriggerProviderMatch } from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import { NormalizedGitLabEventSchema, type NormalizedGitLabEvent } from "./events.js";
import { matchGitLabTriggers, readGitLabInvocationParserMessage } from "./match.js";

/**
 * What a workflow reads as `paseo.event.gitlab.*`. `item` carries whichever subject the event is
 * about — the merge request, the issue, or the comment's target — so a workflow can be written
 * against one shape rather than three.
 */
export interface GitLabMergeData {
  gitlab: {
    event_name: "gitlab.merge_request" | "gitlab.issue" | "gitlab.note";
    delivery_id: string;
    connection_id: string | null;
    received_at: string;
    project: { id: number; path_with_namespace: string; web_url: string | null };
    actor: { id: number | null; username: string };
    item: {
      type: "merge_request" | "issue" | "note";
      iid: number | null;
      title: string | null;
      body: string;
      url: string | null;
      action: string;
      source_branch: string | null;
      target_branch: string | null;
      noteable_type: string | null;
    };
  };
}

/**
 * GitLab v1 is inbound only: Hub mints no GitLab credential and posts nothing back, so a launch
 * has no reply target. The output context exists to identify the source, not to write to it.
 */
export interface GitLabOutputContext {
  provider: "gitlab";
  connectionId: string;
  projectId: number;
  projectPath: string;
}

export interface GitLabTriggerContext {
  provider: "gitlab";
  target: GitLabOutputContext;
  event: GitLabMergeData;
}

export function createGitLabTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
}): TriggerProvider<"gitlab", GitLabTriggerContext, GitLabOutputContext> {
  return {
    name: "gitlab",
    eventNames: ["gitlab.merge_request", "gitlab.issue", "gitlab.note"],
    async match(externalTrigger) {
      const event = NormalizedGitLabEventSchema.parse(externalTrigger.payload);
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (
        !stored.configuration.triggers.some((candidate) => candidate.on === externalTrigger.source)
      ) {
        return "no_trigger_for_source";
      }

      const matchedTriggers = matchGitLabTriggers(
        stored.configuration,
        event,
        externalTrigger.connectionId,
      );
      if (matchedTriggers.length === 0) return "trigger_filters_rejected";

      const matches: TriggerProviderMatch<GitLabTriggerContext, GitLabOutputContext>[] = [];
      for (const matched of matchedTriggers) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === matched.trigger.name,
        );
        if (compiledTrigger === undefined) {
          throw new Error(`compiled trigger not found: ${matched.trigger.name}`);
        }
        const outputContext = buildOutputContext(event, externalTrigger.connectionId);
        const triggerContext: GitLabTriggerContext = {
          provider: "gitlab",
          target: outputContext,
          event: buildGitLabMergeData(event, externalTrigger.connectionId),
        };
        const invocation = parseInvocation(
          event.item.body,
          compiledTrigger.inputs,
          undefined,
          readGitLabInvocationParserMessage(event, compiledTrigger.filters),
        );
        const base = {
          conversation: gitLabConversation(event),
          triggerName: matched.trigger.name,
          triggerContext,
          outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
        };
        if (invocation.status === "rejected") {
          matches.push({ ...base, invocation });
          continue;
        }
        if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
        matches.push({ ...base, invocation });
      }

      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },
  };
}

/**
 * One merge request or issue is one conversation, so a comment continues the run its subject
 * started. GitLab numbers merge requests and issues separately, so the subject's kind belongs in
 * the key: issue #5 and merge request !5 in the same project are not the same thread.
 */
function gitLabConversation(
  event: NormalizedGitLabEvent,
): import("../continuation.js").Conversation | null {
  const iid = event.item.iid;
  const subject = event.type === "note" ? event.item.noteableType : event.item.type;
  if (iid === null || subject === null) return null;
  return {
    key: JSON.stringify(["gitlab", event.project.id, subject, iid]),
    label: `${event.project.pathWithNamespace}${subject === "issue" ? "#" : "!"}${String(iid)}`,
    ...(event.item.url === null ? {} : { url: event.item.url }),
  };
}

function buildOutputContext(
  event: NormalizedGitLabEvent,
  connectionId: string | null | undefined,
): GitLabOutputContext {
  return {
    provider: "gitlab",
    connectionId: connectionId ?? event.connectionId,
    projectId: event.project.id,
    projectPath: event.project.pathWithNamespace,
  };
}

export function buildGitLabMergeData(
  event: NormalizedGitLabEvent,
  connectionId: string | null | undefined,
): GitLabMergeData {
  return {
    gitlab: {
      event_name: `gitlab.${event.type}`,
      delivery_id: event.id,
      connection_id: connectionId ?? event.connectionId,
      received_at: event.receivedAt,
      project: {
        id: event.project.id,
        path_with_namespace: event.project.pathWithNamespace,
        web_url: event.project.webUrl,
      },
      actor: { id: event.actor.id, username: event.actor.username },
      item: {
        type: event.item.type,
        iid: event.item.iid,
        title: event.item.title,
        body: event.item.body,
        url: event.item.url,
        action: event.item.action,
        source_branch: event.item.sourceBranch,
        target_branch: event.item.targetBranch,
        noteable_type: event.item.noteableType,
      },
    },
  };
}
