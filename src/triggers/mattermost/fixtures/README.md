# Mattermost fixtures

Every file here was **recorded from a real Mattermost server**, not written by hand. The zod
schemas in `../events.ts` are derived from these recordings.

- **Server:** `mattermost/mattermost-team-edition:latest`, version `11.10.0`
- **Recorded:** 2026-08-17
- **How:** a bot account connected to `/api/v4/websocket` with
  `authentication_challenge`, while an admin posted messages. Responses captured verbatim.

Re-record with the gated live test (`contract.real.test.ts`) when bumping the pinned version.

## What the recordings settled

These were open questions before the recording. Each answer is now fact, and several
contradicted the initial design.

| Question                                             | Answer                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ | --- | ------------ |
| Is `data.post` a JSON-encoded string?                | **Yes.** It must be `JSON.parse`d before use.                                              |
| Is `data.channel_type` present?                      | **Yes** — `O` public, `P` private, `D` direct message.                                     |
| Is `data.team_id` present?                           | **Yes for `O`/`P`, and the empty string `""` for `D`.**                                    |
| Is `data.sender_name` present?                       | **Yes**, `@`-prefixed (e.g. `"@admin"`). Saves a user lookup.                              |
| Is `data.mentions` present?                          | **Only when someone is mentioned**, as a JSON-encoded array of user IDs. Absent otherwise. |
| Does `broadcast.team_id` carry the team?             | **No — it is always `""`.** The team is on `data`, not `broadcast`.                        |
| Is `root_id` null on root posts?                     | **No, it is `""`.** Use `                                                                  |     | `, not `??`. |
| Are attachment shapes on the event?                  | **Yes**, `post.metadata.files[]` — no extra round trip.                                    |
| Does a bot receive events for channels it is not in? | **No. Zero frames.** Silent no-op.                                                         |
| Can a bot post to a channel it is not in?            | **No** — `403 api.context.permissions.app_error`.                                          |
| Is bot creation enabled by default?                  | **No** — `403 api.bot.create_disabled`.                                                    |
| Are personal access tokens enabled by default?       | **No** — `EnableUserAccessTokens` is `false`.                                              |
| Where is the team-admin role?                        | **`/users/me/teams/members`**, not `/users/me/teams`.                                      |

## Files

| File                          | Contents                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `hello.json`                  | The `hello` frame following a successful `authentication_challenge`.                                      |
| `posted-public-channel.json`  | Mention in a public (`O`) channel.                                                                        |
| `posted-private-channel.json` | Mention in a private (`P`) channel.                                                                       |
| `posted-thread-reply.json`    | Mention on a reply, carrying a non-empty `root_id`.                                                       |
| `posted-direct-message.json`  | DM (`D`) with `data.team_id === ""` — the reason DMs are dropped.                                         |
| `posted-no-mention.json`      | Ordinary chatter with no `mentions` key — must be dropped.                                                |
| `posted-with-attachment.json` | Post carrying `file_ids` and `post.metadata.files`.                                                       |
| `rest-shapes.json`            | Reactions, thread fetch, team listing, team members, file info/download, and the failure responses above. |
