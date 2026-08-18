import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch } from "../index.js";
import type {
  MattermostBotClient,
  MattermostThreadMessage,
  MattermostThreadReadResult,
} from "./client.js";
import { createMattermostTriggerProvider, type MattermostTriggerContext } from "./provider.js";

const TEAM = "n647fxr7atdepji7rcpw4qtdia";
const CHANNEL = "sc9zjmkpc3fzpxa1i8sgd48u4c";
const POST = "gya6fp1krpnzurby4ko68edsiw";
/** Kept out of the test body so the assertion does not nest another callback. */
function threadContents(messages: readonly { content: string }[]): string[] {
  return messages.map((message) => message.content);
}

const ROOT = "k1x4ye4qhbrs5cyt7ikgqfoxjr";
const BOT = { userId: "r8busjtmztnxdro8a1bam8j5fh", username: "paseobot" };
const AUTHOR = "aj9nptmxafyq7fmi4pmwe1oysr";

describe("Mattermost trigger provider", () => {
  it("matches a mention and targets the reply at the post's own thread", async () => {
    const { provider, client, external } = await harness();
    const matches = await provider.match(external());
    if (typeof matches === "string") throw new Error(`expected matches, got ${matches}`);

    assert.equal(matches.length, 1);
    const [match] = matches;
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected an accepted match");
    assert.equal(match.triggerName, "mattermost-run");
    assert.deepEqual(match.outputContext, {
      provider: "mattermost",
      organizationId: "org-1",
      teamId: TEAM,
      channelId: CHANNEL,
      // A root post replies into itself, which is what starts a thread in Mattermost.
      rootId: POST,
      postId: POST,
    });
    // The prompt keeps the whole message, mention included, like every other textual trigger.
    assert.equal(match.invocation.prompt, "@paseobot deploy now");
    assert.deepEqual(client.reactions, []);
  });

  it("targets the existing root when the mention is mid-thread", async () => {
    const { provider, external } = await harness();
    const matches = await provider.match(external({ rootId: ROOT }));
    if (typeof matches === "string") throw new Error("expected matches");
    assert.equal(matches[0]?.outputContext.rootId, ROOT);
  });

  it("reports configuration_unavailable when the bot identity is unknown", async () => {
    const { provider, external } = await harness({ identity: undefined });
    assert.equal(await provider.match(external()), "configuration_unavailable");
  });

  it("rejects a message that names a different bot", async () => {
    const { provider, external } = await harness();
    assert.equal(
      await provider.match(external({ content: "@paseo deploy now" })),
      "trigger_filters_rejected",
    );
  });

  it("carries the sender username through without a lookup round trip", async () => {
    const { provider, external } = await harness();
    const matches = await provider.match(external());
    if (typeof matches === "string") throw new Error("expected matches");
    assert.deepEqual(matches[0]?.triggerContext.event.mattermost.trigger_message.author, {
      id: AUTHOR,
      username: "operator",
    });
  });

  describe("thread context", () => {
    it("is not_applicable for a root post", async () => {
      const { provider, external, launch } = await harness();
      const matches = await provider.match(external());
      if (typeof matches === "string") throw new Error("expected matches");
      const context = await provider.materializeContext!(launch(matches[0]!));
      assert.equal(context.mattermost.thread.status, "not_applicable");
      assert.deepEqual(context.mattermost.thread.messages, []);
    });

    it("hydrates the thread for a mid-thread mention", async () => {
      const { provider, client, external, launch } = await harness({
        threadMessages: [threadMessage("earlier"), threadMessage("later")],
      });
      const matches = await provider.match(external({ rootId: ROOT }));
      if (typeof matches === "string") throw new Error("expected matches");
      const context = await provider.materializeContext!(launch(matches[0]!));

      assert.deepEqual(client.threadReads, [ROOT]);
      assert.equal(context.mattermost.thread.status, "available");
      assert.deepEqual(threadContents(context.mattermost.thread.messages), ["earlier", "later"]);
    });

    it("reports incomplete when the client truncated the thread", async () => {
      const { provider, external, launch } = await harness({
        threadMessages: [threadMessage("earlier")],
        threadComplete: false,
      });
      const matches = await provider.match(external({ rootId: ROOT }));
      if (typeof matches === "string") throw new Error("expected matches");
      const context = await provider.materializeContext!(launch(matches[0]!));
      assert.equal(context.mattermost.thread.status, "incomplete");
    });

    it("degrades to unavailable rather than failing the launch", async () => {
      const { provider, external, launch } = await harness({ failThreadRead: true });
      const matches = await provider.match(external({ rootId: ROOT }));
      if (typeof matches === "string") throw new Error("expected matches");
      const context = await provider.materializeContext!(launch(matches[0]!));
      assert.equal(context.mattermost.thread.status, "unavailable");
      assert.deepEqual(context.mattermost.thread.messages, []);
    });
  });

  describe("reaction lifecycle", () => {
    it("walks eyes → hourglass → check across the happy path", async () => {
      const { provider, client, external } = await harness();
      const matches = await provider.match(external());
      if (typeof matches === "string") throw new Error("expected matches");
      const context = matches[0]!.triggerContext;
      const target = matches[0]!.outputContext;

      const accepted = await provider.onDispatchAccepted!(context, target, undefined);
      const started = await provider.onAgentExecutionStarted!(context, target, accepted!);
      await provider.onAgentExecutionCompleted!(context, target, { status: "succeeded" }, started!);

      assert.deepEqual(client.reactions, [
        "remove:eyes",
        "add:hourglass_flowing_sand",
        "remove:hourglass_flowing_sand",
        "add:white_check_mark",
      ]);
    });

    it("is idempotent when dispatch is accepted twice", async () => {
      const { provider, client, external } = await harness();
      const matches = await provider.match(external());
      if (typeof matches === "string") throw new Error("expected matches");
      const context = matches[0]!.triggerContext;
      const target = matches[0]!.outputContext;

      const first = await provider.onDispatchAccepted!(context, target, undefined);
      const second = await provider.onDispatchAccepted!(context, target, first!);
      assert.deepEqual(second, first);

      const started = await provider.onAgentExecutionStarted!(context, target, second!);
      const again = await provider.onAgentExecutionStarted!(context, target, started!);
      assert.deepEqual(again, started);
      // The second start is a no-op — the emoji swap must not run twice.
      assert.deepEqual(client.reactions, ["remove:eyes", "add:hourglass_flowing_sand"]);
    });

    it("marks a failure and posts a notice into the thread", async () => {
      const { provider, client, external } = await harness();
      const matches = await provider.match(external());
      if (typeof matches === "string") throw new Error("expected matches");
      const context = matches[0]!.triggerContext;
      const target = matches[0]!.outputContext;

      const accepted = await provider.onDispatchAccepted!(context, target, undefined);
      const started = await provider.onAgentExecutionStarted!(context, target, accepted!);
      await provider.onAgentExecutionFailed!(context, target, "daemon_disconnected", started!);

      assert.deepEqual(client.reactions.slice(-2), ["remove:hourglass_flowing_sand", "add:x"]);
      assert.equal(client.messages.length, 1);
      assert.deepEqual(client.messages[0], {
        organizationId: "org-1",
        teamId: TEAM,
        channelId: CHANNEL,
        rootId: POST,
        content: "Paseo agent failed: daemon_disconnected",
      });
    });

    it("leaves a terminated machine alone unless the run actually failed", async () => {
      const { provider, client, external } = await harness();
      const matches = await provider.match(external());
      if (typeof matches === "string") throw new Error("expected matches");
      const context = matches[0]!.triggerContext;

      const state = await provider.onMachineTerminated!(context, "completed", { phase: "started" });
      assert.deepEqual(state, { phase: "started" });
      assert.deepEqual(client.reactions, []);
      assert.deepEqual(client.messages, []);
    });

    it("does not let a reaction cleanup error abort the lifecycle", async () => {
      const { provider, client, external } = await harness({ failRemoveReaction: true });
      const matches = await provider.match(external());
      if (typeof matches === "string") throw new Error("expected matches");
      const context = matches[0]!.triggerContext;
      const target = matches[0]!.outputContext;

      const started = await provider.onAgentExecutionStarted!(context, target, {
        phase: "accepted",
      });
      assert.deepEqual(started, { phase: "started" });
      assert.ok(client.reactions.includes("add:hourglass_flowing_sand"));
    });
  });
});

async function harness(
  options: {
    identity?: { userId: string; username: string } | undefined;
    threadMessages?: MattermostThreadMessage[];
    threadComplete?: boolean;
    failThreadRead?: boolean;
    failRemoveReaction?: boolean;
  } = {},
) {
  const database = createMemoryDatabase();
  const { project, revision, store } = await createActiveProjectConfiguration(
    database,
    configuration(),
    { organizationId: "org-1" },
  );
  const client = new RecordingMattermostClient(options);
  const provider = createMattermostTriggerProvider({
    configurationStoreForProject: () => store,
    botIdentityForTeam: () => Promise.resolve("identity" in options ? options.identity : BOT),
    client,
  });
  return {
    provider,
    client,
    projectId: project.id,
    external: (overrides: Parameters<typeof buildExternal>[2] = {}) =>
      buildExternal(project.id, revision.id, overrides),
    launch: (match: { triggerContext: MattermostTriggerContext }) => ({
      executionId: "execution-mattermost-materialize",
      organizationId: "org-1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: match.triggerContext,
    }),
  };
}

function threadMessage(content: string): MattermostThreadMessage {
  return {
    postId: `post-${content}`,
    content,
    createAt: 1_700_000_000_000,
    author: { id: AUTHOR },
    createdAt: new Date(1_700_000_000_000).toISOString(),
    attachments: [],
  };
}

function buildExternal(
  projectId: string,
  configurationRevisionId: string,
  overrides: { rootId?: string | null; content?: string; authorId?: string } = {},
) {
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
    organizationId: "org-1",
    projectId,
    configurationRevisionId,
    connectionId: "22222222-2222-4222-8222-222222222229",
    source: "mattermost.mention",
    deliveryId: `mattermost-${POST}`,
    receivedAt: new Date(),
    payload: {
      type: "mention" as const,
      id: POST,
      teamId: TEAM,
      channelId: CHANNEL,
      channelType: "O",
      postId: POST,
      rootId: overrides.rootId ?? null,
      createAt: 1_700_000_000_000,
      content: overrides.content ?? "@paseobot deploy now",
      author: { id: overrides.authorId ?? AUTHOR, username: "operator" },
      mentionedUserIds: [BOT.userId],
      createdAt: new Date(1_700_000_000_000).toISOString(),
      attachments: [],
    },
  };
}

function configuration() {
  return {
    environments: [{ name: "mattermost-runner", kind: "daemon", daemon: "main", cwd: "/repo" }],
    triggers: [
      {
        name: "mattermost-run",
        on: "mattermost.mention",
        max_runtime: "2h",
        filters: { team: TEAM, channels: [CHANNEL], from_users: [AUTHOR] },
        steps: [
          {
            id: "mattermost-step",
            environment: "mattermost-runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "test", mode: "full-access" },
            prompt: [{ text: "Handle the Mattermost mention." }],
            allow_outputs: [{ type: "mattermost.reply" }],
          },
        ],
      },
    ],
  };
}

class RecordingMattermostClient implements MattermostBotClient {
  reactions: string[] = [];
  messages: Array<{
    organizationId: string;
    teamId: string;
    channelId: string;
    rootId: string;
    content: string;
  }> = [];
  threadReads: string[] = [];

  constructor(
    private readonly options: {
      threadMessages?: MattermostThreadMessage[];
      threadComplete?: boolean;
      failThreadRead?: boolean;
      failRemoveReaction?: boolean;
    } = {},
  ) {}

  sendMessage(input: (typeof this.messages)[number]): Promise<void> {
    this.messages.push(input);
    return Promise.resolve();
  }

  addReaction(input: { name: string }): Promise<void> {
    this.reactions.push(`add:${input.name}`);
    return Promise.resolve();
  }

  removeReaction(input: { name: string }): Promise<void> {
    this.reactions.push(`remove:${input.name}`);
    if (this.options.failRemoveReaction === true) {
      return Promise.reject(new Error("mattermost remove reaction failed"));
    }
    return Promise.resolve();
  }

  readThreadMessages(input: { rootId: string }): Promise<MattermostThreadReadResult> {
    this.threadReads.push(input.rootId);
    if (this.options.failThreadRead === true) {
      return Promise.reject(new Error("thread history unavailable"));
    }
    return Promise.resolve({
      complete: this.options.threadComplete ?? true,
      messages: this.options.threadMessages ?? [],
    });
  }
}
