import { createFileRoute } from "@tanstack/react-router";
import { handleProviderRequest } from "../../../../server/runtime.js";

export const Route = createFileRoute("/api/integrations/gitlab/webhook/$connectionId")({
  server: {
    handlers: { POST: ({ request }) => handleProviderRequest("gitlab.webhook", request) },
  },
});
