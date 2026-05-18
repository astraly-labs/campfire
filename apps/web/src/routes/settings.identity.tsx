import { createFileRoute } from "@tanstack/react-router";

import { IdentitySettingsPanel } from "../components/settings/IdentitySettings";

function SettingsIdentityRoute() {
  return <IdentitySettingsPanel />;
}

export const Route = createFileRoute("/settings/identity")({
  component: SettingsIdentityRoute,
});
