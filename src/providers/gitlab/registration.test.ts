import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import type { OrganizationAccessValue } from "../../auth/organization-access.js";
import type { AuthServer } from "../../auth/server.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type {
  CreateGitLabConnectionInput,
  GitLabConnectionRecord,
  RotateGitLabConnectionTokenInput,
} from "../../db/types.js";
import { hashGitLabToken } from "../../triggers/gitlab/webhook.js";
import { createGitLabRegistration } from "./index.js";

const RevealedConnectionSchema = z.object({
  connectionId: z.string(),
  webhookUrl: z.string(),
  token: z.string(),
});

const RotatedTokenSchema = z.object({ token: z.string() });

describe("GitLab registration", () => {
  it("registers an inbound-only slice with no output and one webhook request", () => {
    const registration = createGitLabRegistration({
      database: createMemoryDatabase(),
      auth: new RegistrationAuth(),
      publicBaseUrl: "https://hub.test",
    });

    assert.equal(registration.connection.name, "gitlab");
    assert.equal(registration.sources.length, 1);
    assert.equal(registration.triggerProviders.length, 1);
    assert.deepEqual(registration.outputs, []);
    assert.deepEqual(
      registration.requests.map((request) => request.name),
      ["gitlab.webhook"],
    );
  });

  it("reports connection status from the organization's GitLab connections", () => {
    const registration = createGitLabRegistration({
      database: createMemoryDatabase(),
      auth: new RegistrationAuth(),
      publicBaseUrl: "https://hub.test",
    });

    assert.deepEqual(
      registration.connection.status({
        github: [],
        discord: [],
        slack: [],
        linear: [],
        mattermost: [],
        gitlab: [],
      }),
      { status: "disconnected" },
    );
    assert.deepEqual(
      registration.connection.status({
        github: [],
        discord: [],
        slack: [],
        linear: [],
        mattermost: [],
        gitlab: [connectionRecord()],
      }),
      { status: "connected", connections: [connectionRecord()] },
    );
  });

  it("reveals the token once, with the webhook URL, and stores only its hash", async () => {
    let created: CreateGitLabConnectionInput | undefined;
    const database = memoryDatabase();
    database.createGitLabConnection = (input) => {
      created = input;
      return Promise.resolve(connectionRecord());
    };
    const registration = createGitLabRegistration({
      database,
      auth: new RegistrationAuth(),
      publicBaseUrl: "https://hub.test",
    });

    const response = await registration.connection.actions["create"]!(
      new Request("https://hub.test/create?organizationSlug=org", {
        method: "POST",
        body: JSON.stringify({
          organizationSlug: "org",
          label: "Acme GitLab",
          baseUrl: "https://gitlab.example.com",
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = RevealedConnectionSchema.parse(await response.json());
    assert.equal(
      body.webhookUrl,
      "https://hub.test/api/integrations/gitlab/webhook/44444444-4444-4444-8444-444444444444",
    );
    assert.equal(created?.slug, "acme-gitlab-gitlab");
    assert.equal(created?.baseUrl, "https://gitlab.example.com");
    assert.notEqual(created?.tokenHash, body.token);
    assert.equal(created?.tokenHash, hashGitLabToken(body.token));
  });

  it("issues a fresh token on rotation and reports an unowned connection as not found", async () => {
    const rotations: RotateGitLabConnectionTokenInput[] = [];
    const database = memoryDatabase();
    database.rotateGitLabConnectionToken = (input) => {
      rotations.push(input);
      return Promise.resolve(rotations.length === 1);
    };
    const registration = createGitLabRegistration({
      database,
      auth: new RegistrationAuth(),
      publicBaseUrl: "https://hub.test",
    });
    const rotate = () =>
      registration.connection.actions["rotate"]!(
        new Request(
          "https://hub.test/rotate?organizationSlug=org&connectionId=44444444-4444-4444-8444-444444444444",
          { method: "POST" },
        ),
      );

    const first = await rotate();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("Cache-Control"), "no-store");
    const { token } = RotatedTokenSchema.parse(await first.json());
    assert.equal(rotations[0]?.tokenHash, hashGitLabToken(token));

    assert.equal((await rotate()).status, 404);
    assert.notEqual(rotations[1]?.tokenHash, rotations[0]?.tokenHash);
  });

  it("refuses every mutation the CSRF check rejects, before touching the database", async () => {
    const database = createMemoryDatabase();
    database.createGitLabConnection = () => {
      throw new Error("must not be reached");
    };
    database.rotateGitLabConnectionToken = () => {
      throw new Error("must not be reached");
    };
    database.disconnectConnection = () => {
      throw new Error("must not be reached");
    };
    const registration = createGitLabRegistration({
      database,
      auth: new RejectingAuth(),
      publicBaseUrl: "https://hub.test",
    });

    for (const action of ["create", "rotate", "disconnect"]) {
      const response = await registration.connection.actions[action]!(
        new Request("https://hub.test/act?organizationSlug=org", { method: "POST" }),
      );
      assert.equal(response.status, 403, action);
    }
  });

  it("returns no token when the connection could not be stored", async () => {
    const database = memoryDatabase();
    database.createGitLabConnection = () =>
      Promise.reject(new Error("insert failed while storing the connection"));
    const registration = createGitLabRegistration({
      database,
      auth: new RegistrationAuth(),
      publicBaseUrl: "https://hub.test",
    });

    const response = await registration.connection.actions["create"]!(
      new Request("https://hub.test/create?organizationSlug=org", {
        method: "POST",
        body: JSON.stringify({
          organizationSlug: "org",
          label: "Acme GitLab",
          baseUrl: "https://gitlab.example.com",
        }),
      }),
    );

    assert.notEqual(response.status, 200);
    const body = await response.text();
    // A token generated for a connection that was never stored is unusable, and must not reach the
    // caller as if it were.
    assert.equal(/[A-Za-z0-9_-]{43}/u.test(body), false);
  });

  it("stays inert without a database rather than half-registering", () => {
    const registration = createGitLabRegistration({
      database: null,
      auth: new RegistrationAuth(),
      publicBaseUrl: "https://hub.test",
    });

    assert.deepEqual(
      registration.connection.status({
        github: [],
        discord: [],
        slack: [],
        linear: [],
        mattermost: [],
        gitlab: [connectionRecord()],
      }),
      { status: "notConfigured" },
    );
    assert.deepEqual(registration.sources, []);
    assert.deepEqual(registration.triggerProviders, []);
    assert.deepEqual(registration.requests, []);
    assert.deepEqual(registration.connection.actions, {});
  });

  it("registers no browser actions without an authentication server", () => {
    const registration = createGitLabRegistration({
      database: createMemoryDatabase(),
      auth: null,
      publicBaseUrl: "https://hub.test",
    });

    assert.equal(registration.sources.length, 1);
    assert.deepEqual(registration.connection.actions, {});
  });
});

/** Connection management resolves the caller's membership, so the fake database has to carry one. */
function memoryDatabase() {
  return createMemoryDatabase({
    memberships: [
      {
        userId: "user",
        organizationId: "org",
        organizationName: "Org",
        organizationSlug: "org",
        membershipId: "membership",
        role: "owner",
      },
    ],
  });
}

function connectionRecord(): GitLabConnectionRecord {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    organizationId: "org",
    slug: "acme-gitlab-gitlab",
    label: "Acme GitLab",
    baseUrl: "https://gitlab.example.com",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

class RegistrationAuth implements AuthServer {
  handle(): Promise<Response> {
    return Promise.resolve(new Response());
  }
  resources(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }
  resolveOrganizationAccess(): Promise<OrganizationAccessValue> {
    return Promise.resolve({
      session: { id: "session" },
      account: { id: "user", name: "User", email: "user@example.test" },
      organization: { id: "org", name: "Org" },
      membership: { id: "membership", role: "owner" },
      capabilities: { view: true, manageMembers: true, manageOwners: true, manageResources: true },
    });
  }
  async resolveAccount() {
    const access = await this.resolveOrganizationAccess();
    return {
      session: { id: access.session.id, activeOrganizationId: null },
      account: access.account,
      isInstanceOperator: false,
    };
  }
  rejectCookieMutation(): Response | undefined {
    return undefined;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class RejectingAuth extends RegistrationAuth {
  override rejectCookieMutation(): Response {
    return new Response("Forbidden", { status: 403 });
  }
}
