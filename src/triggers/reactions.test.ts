import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  addReaction,
  addReactionSafely,
  reactionPhase,
  removeReactionForPhase,
  removeReactionSafely,
  replaceReaction,
  type ReactionPort,
} from "./reactions.js";
import type { TriggerProviderReactionState } from "./index.js";

function recordingPort(fail = false): { port: ReactionPort; calls: string[] } {
  const calls: string[] = [];
  const act = (verb: string) => (name: string) => {
    calls.push(`${verb}:${name}`);
    return fail ? Promise.reject(new Error("provider refused")) : Promise.resolve();
  };
  return {
    calls,
    port: {
      provider: "mattermost",
      emoji: { accepted: "eyes", started: "hourglass" },
      add: act("add"),
      remove: act("remove"),
      diagnostic: (name) => ({ reaction: name }),
    },
  };
}

describe("reaction phase", () => {
  it("reads a phase back out of replayed state", () => {
    assert.equal(reactionPhase({ phase: "accepted" }), "accepted");
    assert.equal(reactionPhase({ phase: "started" }), "started");
  });

  it("treats unrecognized state as no phase rather than throwing", () => {
    // A run whose state was written by an older Hub still has to be able to finish.
    const unusable: (TriggerProviderReactionState | undefined)[] = [
      undefined,
      null,
      "started",
      3,
      [],
      {},
      { phase: "elsewhere" },
    ];
    for (const value of unusable) assert.equal(reactionPhase(value), undefined);
  });
});

describe("phase-driven cleanup", () => {
  it("removes only the emoji the phase says is on the message", async () => {
    const accepted = recordingPort();
    await removeReactionForPhase(accepted.port, { phase: "accepted" });
    assert.deepEqual(accepted.calls, ["remove:eyes"]);

    const started = recordingPort();
    await removeReactionForPhase(started.port, { phase: "started" });
    assert.deepEqual(started.calls, ["remove:hourglass"]);
  });

  it("removes both when the phase is unusable, rather than leaving a stale one", async () => {
    const { port, calls } = recordingPort();
    await removeReactionForPhase(port, undefined);
    assert.deepEqual(calls, ["remove:eyes", "remove:hourglass"]);
  });

  it("prefers the recorded phase over the caller's fallback", async () => {
    const { port, calls } = recordingPort();
    await removeReactionForPhase(port, { phase: "accepted" }, "started");
    assert.deepEqual(calls, ["remove:eyes"]);
  });
});

describe("reaction delivery", () => {
  it("removes before adding, so both in-flight emoji are never up at once", async () => {
    const { port, calls } = recordingPort();
    await replaceReaction(port, "eyes", "hourglass");
    assert.deepEqual(calls, ["remove:eyes", "add:hourglass"]);
  });

  it("swallows failures on the courtesy paths", async () => {
    const { port } = recordingPort(true);
    // A run must not fail because an emoji did not land.
    await addReactionSafely(port, "eyes");
    await removeReactionSafely(port, "eyes");
    await removeReactionForPhase(port, undefined);
  });

  it("lets the caller see a failure on the plain add", async () => {
    const { port } = recordingPort(true);
    await assert.rejects(() => addReaction(port, "white_check_mark"), /provider refused/u);
  });
});
