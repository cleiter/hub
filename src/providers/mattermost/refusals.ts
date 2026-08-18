import { z } from "zod";

const refusalSchema = z.object({ error: z.string() });

/**
 * Turns Mattermost's connect refusals into the next thing the operator should do, or `undefined`
 * if the body is not one Hub authored.
 *
 * Both callers — the connections page and the apps page — need this: a gateway provider's connect
 * either binds teams or refuses for a reason the operator can fix, and the generic "check the app
 * status and provider availability" copy sends them looking in the wrong place. The codes are
 * Mattermost's own, so an unrecognized body falls through to that generic copy.
 */
export async function mattermostStartRefusal(response: Response): Promise<string | undefined> {
  const body = refusalSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => undefined),
  );
  if (!body.success) return undefined;
  if (body.data.error === "mattermost_bot_has_no_teams") {
    return "The bot isn't a member of any Mattermost team yet. Add it to a team, then connect.";
  }
  if (body.data.error === "mattermost_teams_already_connected") {
    return "Every team this bot belongs to is already connected. Add the bot to another team first.";
  }
  return undefined;
}
