import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { PROVIDERS, type Provider } from "../index.js";
import { connectionIdentityQuery, connectionTable } from "./inventory.js";

/**
 * Direct coverage for the two provider→table and provider→query mappings in inventory.ts.
 *
 * The failure mode they guard against: both functions previously fell through to a bare else
 * that returned discord_connections for any unrecognised provider, so a new provider added to
 * `PROVIDERS` would silently touch Discord's rows instead of failing loudly.
 *
 * Keyed on `PROVIDERS`, not `CONNECTION_PROVIDERS`: a connection provider only appears here once
 * it also has an instance-wide application to inventory, which GitLab deliberately does not.
 *
 * The `satisfies` compile-time guard ensures that if `PROVIDERS` gains a new member, the expected
 * table map below stops compiling until someone adds a matching entry.
 */
describe("inventory provider mappings", () => {
  const EXPECTED_TABLES = {
    github: "github_connections",
    slack: "slack_connections",
    discord: "discord_connections",
    linear: "linear_connections",
    mattermost: "mattermost_connections",
  } satisfies Record<Provider, string>;

  it("connectionTable returns the correct table for every provider", () => {
    for (const provider of PROVIDERS) {
      assert.equal(connectionTable(provider), EXPECTED_TABLES[provider]);
    }
  });

  it("every provider maps to a distinct table", () => {
    const tables = PROVIDERS.map(connectionTable);
    assert.equal(new Set(tables).size, tables.length);
  });

  it("connectionIdentityQuery reads from the provider's own table and no other provider's table", () => {
    for (const provider of PROVIDERS) {
      const query = connectionIdentityQuery(provider);
      const ownTable = EXPECTED_TABLES[provider];

      assert.ok(query.includes(ownTable), `query for "${provider}" should mention ${ownTable}`);

      for (const other of PROVIDERS) {
        if (other === provider) continue;
        const otherTable = EXPECTED_TABLES[other];
        assert.ok(
          !query.includes(otherTable),
          `query for "${provider}" should not mention ${otherTable}`,
        );
      }
    }
  });
});
