import type {
  AttachmentResolver,
  AttachmentResolverInput,
} from "../../attachments/capabilities.js";
import type { MattermostBotClient } from "./client.js";

export function createMattermostAttachmentResolver(
  client: MattermostBotClient,
): AttachmentResolver {
  return async (input) => {
    const locator = readMattermostLocator(input);
    if (client.downloadAttachment === undefined) {
      throw new Error("Mattermost attachment download is unavailable");
    }
    return client.downloadAttachment({
      organizationId: input.organizationId,
      teamId: locator.teamId,
      fileId: locator.fileId,
    });
  };
}

function readMattermostLocator(input: AttachmentResolverInput): {
  teamId: string;
  fileId: string;
} {
  if (!isRecord(input.locator)) {
    throw new Error("invalid Mattermost attachment locator");
  }
  const teamId = input.locator["teamId"];
  const fileId = input.locator["fileId"];
  if (
    typeof teamId !== "string" ||
    teamId.length === 0 ||
    typeof fileId !== "string" ||
    fileId.length === 0
  ) {
    throw new Error("invalid Mattermost attachment locator");
  }
  return { teamId, fileId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
