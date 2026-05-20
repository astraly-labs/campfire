import { createFileRoute } from "@tanstack/react-router";

import { WorktreesSettingsPanel } from "../components/settings/WorktreesSettings";

export const Route = createFileRoute("/settings/worktrees")({
  component: WorktreesSettingsPanel,
});
