# TODOs

## Prune provider_event_receipts

**What:** A retention window and periodic delete for `provider_event_receipts`.

**Why:** The table grows unbounded. The only delete in the codebase is
`releaseGitHubLifecycleReceipt` (`src/db/trigger-acceptance.ts`), which removes a single GitHub
lifecycle row. Every other receipt is kept forever, including dropped ones.

**Pros:** Bounds disk growth; keeps the resource index small.

**Cons:** Needs a retention policy decision (how long is a receipt useful for debugging?) and a
scheduled job the Hub does not currently have.

**Context:** Surfaced during the GitLab plan review. GitLab amplifies it — a group hook delivers
every project in the group, and projects with no matching trigger still insert a receipt before
dropping as `no_project_route`. Affects all four providers, not just GitLab.

**Depends on:** Nothing. Independent of the GitLab work.
