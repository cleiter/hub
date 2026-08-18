import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { createDatabase } from "../../db/pg.js";
import { embeddedDatabaseRuntime, type DatabaseRuntimeBundle } from "../../db/runtime/index.js";
import type { Database } from "../../db/types.js";
import { createMattermostBotClient } from "../../triggers/mattermost/client.js";

/**
 * Mattermost's bot token is instance-global: every organization on this Hub posts with the same
 * credential. Slack cannot leak across organizations even if Hub gets the scoping wrong, because
 * the token itself is per connection; Mattermost has no such backstop. These are therefore
 * security tests, not correctness tests — a failure here is cross-organization access.
 */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

describe("Mattermost cross-organization scoping", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{
    bundle: DatabaseRuntimeBundle;
    database: Database;
    close: () => Promise<void>;
  }> {
    const root = await mkdtemp(join(tmpdir(), "hub-mattermost-scoping-"));
    roots.push(root);
    const bundle = await embeddedDatabaseRuntime(root);
    await bundle.runtime.migrate();
    await bundle.runtime.query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at,
                           must_change_password, is_instance_operator)
       values ('operator', 'Operator', 'operator@example.test', true, now(), now(), false, true)`,
    );
    await bundle.runtime.query(
      `insert into organization (id, name, slug) values
         ('org-a', 'Org A', 'org-a'), ('org-b', 'Org B', 'org-b')`,
    );
    await bundle.runtime.query(
      `insert into session (id, token, user_id, active_organization_id, expires_at) values
         ('session-org-a', 'token-a', 'operator', 'org-a', now() + interval '1 hour'),
         ('session-org-b', 'token-b', 'operator', 'org-b', now() + interval '1 hour')`,
    );
    await bundle.runtime.query(
      `insert into member (id, organization_id, user_id, role) values
         ('member-org-a', 'org-a', 'operator', 'owner'),
         ('member-org-b', 'org-b', 'operator', 'owner')`,
    );
    // A bind is only honored while the attempt still names the active provider application, so
    // the fixture has to activate one exactly as saving the app would.
    await bundle.runtime.query(
      `insert into runtime_provider_activation (provider, provider_application_id, configuration_version)
       values ('mattermost', 'https://mattermost.example.com', 1)`,
    );
    return {
      bundle,
      database: createDatabase(bundle.runtime, bundle.locks),
      close: () => bundle.runtime.close(),
    };
  }

  async function bindTeam(
    database: Database,
    organizationId: string,
    teamId: string,
    stateVerifier: string,
  ): Promise<void> {
    const access = {
      sessionId: `session-${organizationId}`,
      userId: "operator",
      membershipId: `member-${organizationId}`,
      organizationId,
      returnRoute: "/settings/apps",
    };
    await database.startConnectionAttempt({
      provider: "mattermost",
      stateVerifier,
      access,
      lifetimeMinutes: 10,
      configurationVersion: 1,
      providerApplicationId: "https://mattermost.example.com",
      callbackOrigin: "https://mattermost.example.com",
      configurationSnapshot: {
        provider: "mattermost",
        serverUrl: "https://mattermost.example.com",
      },
      expectedConfigurationVersion: null,
      activateConfiguration: false,
    });
    await database.bindMattermostConnection({
      providerApplicationId: "https://mattermost.example.com",
      stateVerifier,
      phase: "mattermost_authorization",
      access: { sessionId: access.sessionId, userId: access.userId },
      teamId,
      teamName: teamId,
      teamDisplayName: teamId,
      serverUrl: "https://mattermost.example.com",
      botUserId: "bot-user",
      botUsername: "paseobot",
    });
  }

  it("refuses to bind a team another organization already owns", async () => {
    const { database, close } = await fixture();
    try {
      await bindTeam(database, "org-a", "team-shared", "state-a");
      await assert.rejects(
        () => bindTeam(database, "org-b", "team-shared", "state-b"),
        // Whatever the message, the bind must not succeed: a second row for the same team is
        // one organization reading and answering in another organization's channels.
        (error: unknown) => error instanceof Error,
      );
      assert.equal(
        (await database.findMattermostConnection("team-shared"))?.organizationId,
        "org-a",
      );
    } finally {
      await close();
    }
  });

  it("does not resolve another organization's team", async () => {
    const { database, close } = await fixture();
    try {
      await bindTeam(database, "org-a", "team-a", "state-a");
      assert.notEqual(
        await database.findMattermostConnectionForOrganization("org-a", "team-a"),
        undefined,
      );
      assert.equal(
        await database.findMattermostConnectionForOrganization("org-b", "team-a"),
        undefined,
      );
    } finally {
      await close();
    }
  });

  it("routes an event to the organization that bound the team, and drops an unbound one", async () => {
    const { bundle, database, close } = await fixture();
    try {
      await bindTeam(database, "org-a", "team-a", "state-a");
      const accepted = await database.acceptMattermostEvent({
        teamId: "team-a",
        deliveryId: "mattermost-post-1",
        source: "mattermost.mention",
        payload: { postId: "post-1" },
        receivedAt: new Date(),
        signatureHash: null,
      });
      const owner = await bundle.runtime.query<{ organization_id: string | null }>(
        `select organization_id from provider_event_receipts where id = $1`,
        [accepted.receiptId],
      );
      assert.equal(owner.rows[0]?.organization_id, "org-a");

      const unbound = await database.acceptMattermostEvent({
        teamId: "team-unbound",
        deliveryId: "mattermost-post-2",
        source: "mattermost.mention",
        payload: { postId: "post-2" },
        receivedAt: new Date(),
        signatureHash: null,
      });
      assert.equal(unbound.status, "dropped");
      if (unbound.status !== "dropped") throw new Error("expected a dropped event");
      assert.equal(unbound.reason, "mattermost_unbound");
    } finally {
      await close();
    }
  });

  it("never sends the instance-global token to another organization's team", async () => {
    const { database, close } = await fixture();
    try {
      await bindTeam(database, "org-a", "team-a", "state-a");
      const calls: string[] = [];
      const client = createMattermostBotClient({
        serverUrl: "https://mattermost.example.com",
        tokenForTeam: async (organizationId, teamId) =>
          (await database.findMattermostConnectionForOrganization(organizationId, teamId)) ===
          undefined
            ? undefined
            : "bot-token",
        botUserIdForTeam: async (organizationId, teamId) =>
          (await database.findMattermostConnectionForOrganization(organizationId, teamId))
            ?.botUserId,
        fetch: (input) => {
          calls.push(requestUrl(input));
          return Promise.resolve(Response.json({ id: "post-2" }, { status: 201 }));
        },
      });

      await assert.rejects(
        client.sendMessage({
          organizationId: "org-b",
          teamId: "team-a",
          channelId: "channel-a",
          rootId: "post-1",
          content: "hello",
        }),
        /not connected/u,
      );
      await assert.rejects(
        client.addReaction({
          organizationId: "org-b",
          teamId: "team-a",
          postId: "post-1",
          name: "eyes",
        }),
        // Reactions resolve the bot's identity first, so this path refuses one step earlier.
        /identity is unavailable/u,
      );
      // The refusal happens before the request is built, so no credential ever reaches the wire.
      assert.deepEqual(calls, []);

      await client.sendMessage({
        organizationId: "org-a",
        teamId: "team-a",
        channelId: "channel-a",
        rootId: "post-1",
        content: "hello",
      });
      assert.equal(calls.length, 1);
    } finally {
      await close();
    }
  });
});
