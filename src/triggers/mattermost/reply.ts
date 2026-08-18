import { z } from "zod";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { MattermostBotClient } from "./client.js";

const MattermostReplyArgsSchema = z.object({ content: z.string().min(1) });
const MattermostReplyOutputContextSchema = z.object({
  organizationId: z.string().min(1),
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  rootId: z.string().min(1),
});

export function createMattermostReplyExecutor(options: {
  client: MattermostBotClient;
}): OutputExecutor {
  return async function executeMattermostReply(input) {
    const args = MattermostReplyArgsSchema.parse(input.args);
    const context = MattermostReplyOutputContextSchema.parse(input.outputContext);
    await options.client.sendMessage({ ...context, content: args.content });
  };
}
