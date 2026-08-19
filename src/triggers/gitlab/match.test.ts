import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import type { NormalizedGitLabEvent } from "./events.js";
import { matchGitLabTriggers, readGitLabInvocationParserMessage } from "./match.js";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

describe("GitLab trigger matching", () => {
  it("matches a merge request that satisfies every filter", () => {
    assert.equal(matchGitLabTriggers(config(), event(), CONNECTION_ID).length, 1);
  });

  it("rejects each filter independently", () => {
    assert.equal(
      matchGitLabTriggers(config(), event({ project: "acme/frontend" }), CONNECTION_ID).length,
      0,
      "project",
    );
    assert.equal(
      matchGitLabTriggers(config(), event({ actor: "mallory" }), CONNECTION_ID).length,
      0,
      "from_users",
    );
    assert.equal(
      matchGitLabTriggers(config(), event({ body: "ship it" }), CONNECTION_ID).length,
      0,
      "pattern",
    );
    assert.equal(
      matchGitLabTriggers(config(), event(), "22222222-2222-4222-8222-222222222222").length,
      0,
      "connection",
    );
  });

  it("ignores merge request updates unless the trigger asks for them", () => {
    assert.equal(
      matchGitLabTriggers(config(), event({ action: "update" }), CONNECTION_ID).length,
      0,
    );
    assert.equal(
      matchGitLabTriggers(
        config({ actions: ["update"] }),
        event({ action: "update" }),
        CONNECTION_ID,
      ).length,
      1,
    );
  });

  it("accepts the merge and reopen actions a merge request trigger defaults to", () => {
    for (const action of ["open", "reopen", "merge"]) {
      assert.equal(
        matchGitLabTriggers(config(), event({ action }), CONNECTION_ID).length,
        1,
        action,
      );
    }
  });

  it("ignores comments on commits and snippets while accepting merge request comments", () => {
    const noteConfig = config({ on: "gitlab.note" });
    const comment = { kind: "note" as const, action: "create" };

    assert.equal(
      matchGitLabTriggers(
        noteConfig,
        event({ ...comment, noteableType: "merge_request" }),
        CONNECTION_ID,
      ).length,
      1,
    );
    assert.equal(
      matchGitLabTriggers(noteConfig, event({ ...comment, noteableType: "commit" }), CONNECTION_ID)
        .length,
      0,
    );
    assert.equal(
      matchGitLabTriggers(noteConfig, event({ ...comment, noteableType: null }), CONNECTION_ID)
        .length,
      0,
      "an unreported target cannot be shown to satisfy the filter",
    );
    assert.equal(
      matchGitLabTriggers(
        config({ on: "gitlab.note", noteable: ["commit"] }),
        event({ ...comment, noteableType: "commit" }),
        CONNECTION_ID,
      ).length,
      1,
    );
  });

  it("requires the pattern to end on a word boundary", () => {
    assert.equal(
      matchGitLabTriggers(config(), event({ body: "/reviewers should look" }), CONNECTION_ID)
        .length,
      0,
    );
    assert.equal(
      matchGitLabTriggers(config(), event({ body: "/review" }), CONNECTION_ID).length,
      1,
    );
  });

  it("hands the agent the request rather than the command marker", () => {
    const compiled = config().triggers[0]!;
    assert.equal(
      readGitLabInvocationParserMessage(event(), compiled.filters),
      "please check the invalidation path",
    );
  });

  it("refuses a trigger whose filters carry no actor allowlist", () => {
    const withoutUsers = {
      triggers: [
        { name: "review", on: "gitlab.merge_request", filters: { project: "acme/backend" } },
      ],
    };
    assert.equal(matchGitLabTriggers(withoutUsers, event(), CONNECTION_ID).length, 0);
  });
});

/**
 * `connectionId` is a compiled-only filter — the configuration store resolves it while deriving
 * routes, so it cannot be authored. It is grafted on after compilation to exercise the check the
 * same way a real compiled configuration would carry it.
 */
function config(
  overrides: {
    on?: string;
    actions?: string[];
    noteable?: string[];
  } = {},
) {
  const compiled = compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "review",
        on: overrides.on ?? "gitlab.merge_request",
        max_runtime: "2h",
        filters: {
          project: "acme/backend",
          from_users: ["alice"],
          pattern: "/review",
          ...(overrides.actions === undefined ? {} : { actions: overrides.actions }),
          ...(overrides.noteable === undefined ? {} : { noteable: overrides.noteable }),
        },
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
  const trigger = compiled.triggers[0]!;
  return {
    ...compiled,
    triggers: [{ ...trigger, filters: { ...trigger.filters, connectionId: CONNECTION_ID } }],
  };
}

function event(
  overrides: {
    kind?: "merge_request" | "issue" | "note";
    project?: string;
    actor?: string;
    body?: string;
    action?: string;
    noteableType?: string | null;
  } = {},
): NormalizedGitLabEvent {
  const kind = overrides.kind ?? "merge_request";
  return {
    id: "gitlab:connection:delivery",
    type: kind,
    connectionId: CONNECTION_ID,
    project: {
      id: 4242,
      pathWithNamespace: overrides.project ?? "acme/backend",
      webUrl: "https://gitlab.example.com/acme/backend",
    },
    actor: { id: 41, username: overrides.actor ?? "alice" },
    item: {
      type: kind,
      iid: 7,
      title: "Cache the project lookup",
      body: overrides.body ?? "/review please check the invalidation path",
      url: "https://gitlab.example.com/acme/backend/-/merge_requests/7",
      action: overrides.action ?? "open",
      sourceBranch: "cache-project-lookup",
      targetBranch: "main",
      noteableType: overrides.noteableType === undefined ? null : overrides.noteableType,
    },
    receivedAt: "2026-01-01T00:00:00.000Z",
    payload: {},
  };
}
