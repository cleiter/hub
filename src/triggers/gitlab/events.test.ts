import assert from "node:assert/strict";
import { describe, it } from "vitest";
import mergeRequestOpen from "../fixtures/gl-merge-request-open.json" with { type: "json" };
import issueOpen from "../fixtures/gl-issue-open.json" with { type: "json" };
import noteOnMergeRequest from "../fixtures/gl-note-merge-request.json" with { type: "json" };
import legacyMergeRequestOpen from "../fixtures/gl-legacy-merge-request-open.json" with { type: "json" };
import { normalizeGitLabEvent, normalizeNoteableType } from "./events.js";

const RECEIVED_AT = new Date("2026-01-01T00:00:00.000Z");

describe("GitLab event normalization", () => {
  it("reads the merge request subject and its description as the invocation text", () => {
    const event = normalize("merge_request", mergeRequestOpen);

    assert.equal(event?.project.id, 4242);
    assert.equal(event?.project.pathWithNamespace, "acme/backend");
    assert.equal(event?.actor.username, "alice");
    assert.equal(event?.item.iid, 7);
    assert.equal(event?.item.action, "open");
    assert.equal(event?.item.sourceBranch, "cache-project-lookup");
    assert.equal(event?.item.body, "/review please check the invalidation path");
  });

  it("reads an issue description as the invocation text", () => {
    const event = normalize("issue", issueOpen);

    assert.equal(event?.item.iid, 12);
    assert.equal(event?.item.body, "/triage the importer times out after the third batch");
    assert.equal(event?.item.noteableType, null);
  });

  it("reads a comment's own text and reports the subject it is attached to", () => {
    const event = normalize("note", noteOnMergeRequest);

    assert.equal(event?.item.body, "/review take another look at the retry loop");
    assert.equal(event?.item.noteableType, "merge_request");
    // The iid a reader recognises is the merge request's, not the note's internal id.
    assert.equal(event?.item.iid, 7);
    // A comment carries no action of its own.
    assert.equal(event?.item.action, "create");
  });

  /**
   * Constructed to stand in for an older self-managed instance rather than captured from one: it
   * omits `event_type`, `project.web_url` and `user.id`, which current payloads carry. The point is
   * that a missing optional field must not make a delivery unparseable.
   */
  it("parses a payload missing fields that current GitLab versions send", () => {
    const event = normalize("merge_request", legacyMergeRequestOpen);

    assert.notEqual(event, undefined);
    assert.equal(event?.project.webUrl, null);
    assert.equal(event?.actor.id, null);
    assert.equal(event?.actor.username, "legacy");
    assert.equal(event?.item.url, null);
  });

  it("refuses a payload whose object_kind disagrees with the event header", () => {
    assert.equal(normalize("issue", mergeRequestOpen), undefined);
  });

  it("refuses a payload without the fields every trigger decision reads", () => {
    assert.equal(normalize("merge_request", { object_kind: "merge_request" }), undefined);
    assert.equal(
      normalize("merge_request", {
        object_kind: "merge_request",
        user: { username: "alice" },
        project: { path_with_namespace: "acme/backend" },
        object_attributes: {},
      }),
      undefined,
    );
  });

  it("converts GitLab's PascalCase noteable types to authored filter values", () => {
    assert.equal(normalizeNoteableType("MergeRequest"), "merge_request");
    assert.equal(normalizeNoteableType("Issue"), "issue");
    assert.equal(normalizeNoteableType("Commit"), "commit");
    assert.equal(normalizeNoteableType(undefined), null);
  });
});

function normalize(kind: "merge_request" | "issue" | "note", payload: unknown) {
  return normalizeGitLabEvent({
    kind,
    deliveryId: "gitlab:connection:delivery",
    connectionId: "connection",
    payload,
    receivedAt: RECEIVED_AT,
  });
}
