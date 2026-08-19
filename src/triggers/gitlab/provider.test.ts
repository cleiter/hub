import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch } from "../index.js";
import type { NormalizedGitLabEvent } from "./events.js";
import { buildGitLabMergeData, createGitLabTriggerProvider } from "./provider.js";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

describe("GitLab trigger provider", () => {
  it("hands the agent a merge request event as paseo.event.gitlab", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createGitLabTriggerProvider({ configurationStoreForProject: () => store });

    const matches = await provider.match(external(project.id, revision.id, event()));

    if (typeof matches === "string") throw new Error(`expected matches, got ${matches}`);
    const match = matches[0];
    if (match === undefined || !isAcceptedTriggerProviderMatch(match)) {
      throw new Error("expected an accepted match");
    }
    assert.equal(match.triggerName, "review-mr");
    // The whole body, marker included: the trigger's `pattern` is stripped only for input-header
    // parsing, never from the prompt the agent is handed.
    assert.equal(match.invocation.prompt, "/review please check the invalidation path");
    assert.deepEqual(match.outputContext, {
      provider: "gitlab",
      connectionId: CONNECTION_ID,
      projectId: 4242,
      projectPath: "acme/backend",
    });
    assert.deepEqual(match.triggerContext.event.gitlab, {
      event_name: "gitlab.merge_request",
      delivery_id: "gitlab:connection:delivery",
      connection_id: CONNECTION_ID,
      received_at: "2026-01-01T00:00:00.000Z",
      project: {
        id: 4242,
        path_with_namespace: "acme/backend",
        web_url: "https://gitlab.example.com/acme/backend",
      },
      actor: { id: 41, username: "alice" },
      item: {
        type: "merge_request",
        iid: 7,
        title: "Cache the project lookup",
        body: "/review please check the invalidation path",
        url: "https://gitlab.example.com/acme/backend/-/merge_requests/7",
        action: "open",
        source_branch: "cache-project-lookup",
        target_branch: "main",
        noteable_type: null,
      },
    });
  });

  it("hands the same event to a step reading paseo.context", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createGitLabTriggerProvider({ configurationStoreForProject: () => store });
    const matches = await provider.match(external(project.id, revision.id, event()));
    if (typeof matches === "string") throw new Error(`expected matches, got ${matches}`);
    const match = matches[0];
    if (match === undefined || !isAcceptedTriggerProviderMatch(match)) {
      throw new Error("expected an accepted match");
    }

    const context = await provider.materializeContext!({
      executionId: "execution-gitlab",
      organizationId: "org_1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111118",
      triggerContext: match.triggerContext,
    });

    assert.deepEqual(context, match.triggerContext.event);
  });

  it("reports why nothing ran when the configuration has no trigger for the event", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createGitLabTriggerProvider({ configurationStoreForProject: () => store });

    assert.equal(
      await provider.match({
        ...external(project.id, revision.id, event({ kind: "issue" })),
        source: "gitlab.issue",
      }),
      "no_trigger_for_source",
    );
  });

  it("reports a rejected filter separately from a missing trigger", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createGitLabTriggerProvider({ configurationStoreForProject: () => store });

    assert.equal(
      await provider.match(external(project.id, revision.id, event({ actor: "mallory" }))),
      "trigger_filters_rejected",
    );
  });

  it("reports an unreadable configuration revision rather than guessing", async () => {
    const { project, store } = await activeConfiguration();
    const provider = createGitLabTriggerProvider({ configurationStoreForProject: () => store });

    assert.equal(
      await provider.match(external(project.id, "22222222-2222-4222-8222-222222222222", event())),
      "configuration_unavailable",
    );
  });

  it("declares exactly the three event names GitLab v1 accepts", () => {
    const provider = createGitLabTriggerProvider({
      configurationStoreForProject: () => {
        throw new Error("unused");
      },
    });
    assert.deepEqual(provider.eventNames, ["gitlab.merge_request", "gitlab.issue", "gitlab.note"]);
    assert.equal(provider.name, "gitlab");
  });

  it("prefers the receipt's connection over the one recorded in the payload", () => {
    const merged = buildGitLabMergeData(event(), "33333333-3333-4333-8333-333333333333");
    assert.equal(merged.gitlab.connection_id, "33333333-3333-4333-8333-333333333333");
    assert.equal(buildGitLabMergeData(event(), null).gitlab.connection_id, CONNECTION_ID);
  });
});

async function activeConfiguration() {
  return createActiveProjectConfiguration(createMemoryDatabase(), {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "review-mr",
        on: "gitlab.merge_request",
        max_runtime: "2h",
        filters: { project: "acme/backend", from_users: ["alice"], pattern: "/review" },
        steps: [
          {
            id: "review",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "default" },
            prompt: [{ text: "Review the change" }],
          },
        ],
      },
    ],
  });
}

function external(projectId: string, configurationRevisionId: string, payload: unknown) {
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111118",
    organizationId: "org_1",
    projectId,
    configurationRevisionId,
    source: "gitlab.merge_request",
    deliveryId: "gitlab:connection:delivery",
    receivedAt: new Date("2026-01-01T00:00:00.000Z"),
    payload,
    connectionId: CONNECTION_ID,
    resourceId: "4242",
  };
}

function event(
  overrides: { kind?: "merge_request" | "issue"; actor?: string } = {},
): NormalizedGitLabEvent {
  const kind = overrides.kind ?? "merge_request";
  return {
    id: "gitlab:connection:delivery",
    type: kind,
    connectionId: CONNECTION_ID,
    project: {
      id: 4242,
      pathWithNamespace: "acme/backend",
      webUrl: "https://gitlab.example.com/acme/backend",
    },
    actor: { id: 41, username: overrides.actor ?? "alice" },
    item: {
      type: kind,
      iid: 7,
      title: "Cache the project lookup",
      body: "/review please check the invalidation path",
      url: "https://gitlab.example.com/acme/backend/-/merge_requests/7",
      action: "open",
      sourceBranch: "cache-project-lookup",
      targetBranch: "main",
      noteableType: null,
    },
    receivedAt: "2026-01-01T00:00:00.000Z",
    payload: {},
  };
}
