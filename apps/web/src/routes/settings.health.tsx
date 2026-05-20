import { createFileRoute } from "@tanstack/react-router";

import { HealthSettings } from "../components/settings/HealthSettings";

export const Route = createFileRoute("/settings/health")({
  component: HealthSettings,
});
