import type { EnvironmentApi, IdentityCurrentUser } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { createEnvironmentApi } from "../../environmentApi";
import { getPrimaryEnvironmentConnection } from "../../environments/runtime/service";
import { useEnsureIdentityLoaded, useIdentityStore } from "../../identity/identityStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

/**
 * Identity settings panel. Reads the current user from the identity store
 * (resolved server-side via `tailscale whois` or the local-OS fallback) and
 * exposes a server-persisted `display_name_override`.
 *
 * The store is loaded against the primary environment connection because the
 * override lives in the server's `users` table — there is no per-environment
 * concept here, just one identity per Tailscale account.
 */
export function IdentitySettingsPanel() {
  const api = createEnvironmentApi(getPrimaryEnvironmentConnection().client);
  useEnsureIdentityLoaded(api);
  const state = useIdentityStore((store) => store.state);

  if (state.kind === "loading") {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Identity">
          <SettingsRow
            title="Loading identity…"
            description="Resolving your identity via the server."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  if (state.kind === "error") {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Identity">
          <SettingsRow
            title="Identity unavailable"
            description={state.message}
            control={
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void useIdentityStore.getState().load(api)}
              >
                Retry
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return <ReadyPanel result={state.result} api={api} />;
}

function ReadyPanel({ result, api }: { result: IdentityCurrentUser; api: EnvironmentApi }) {
  const [draft, setDraft] = useState(result.user.displayName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync local draft when the store changes (e.g. after a successful save or
  // reset from elsewhere) so the input never displays a stale value.
  useEffect(() => {
    setDraft(result.user.displayName);
  }, [result.user.displayName]);

  const trimmed = draft.trim();
  const isUnchanged = trimmed === result.user.displayName;

  const handleSave = async () => {
    if (pending || isUnchanged || !trimmed) return;
    setPending(true);
    setError(null);
    try {
      await useIdentityStore.getState().setDisplayName(api, trimmed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save display name");
    } finally {
      setPending(false);
    }
  };

  const handleReset = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await useIdentityStore.getState().clearDisplayName(api);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to reset display name");
    } finally {
      setPending(false);
    }
  };

  const sourceLabel =
    result.source === "tailscale-whois" ? "Tailscale whois" : "Local user (no Tailscale)";

  return (
    <SettingsPageContainer>
      <SettingsSection title="Identity">
        <SettingsRow
          title="Account"
          description="Stable identifier used to attribute your messages on this server."
          status={
            <span className="inline-flex items-center gap-2">
              <span>{result.user.id}</span>
              <Badge
                variant="secondary"
                className="rounded-md bg-muted/60 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {sourceLabel}
              </Badge>
            </span>
          }
        />
        <SettingsRow
          title="Display name"
          description="Shown to teammates in side threads and inboxes. Defaults to your Tailscale name; you can override it here."
          resetAction={
            result.hasOverride ? (
              <SettingResetButton
                label={`display name (back to ${result.canonicalDisplayName})`}
                onClick={() => void handleReset()}
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleSave();
                  }
                }}
                placeholder={result.canonicalDisplayName}
                className="h-8 w-56"
                disabled={pending}
              />
              <Button
                size="xs"
                onClick={() => void handleSave()}
                disabled={pending || isUnchanged || !trimmed}
              >
                Save
              </Button>
            </div>
          }
        />
        {error ? (
          <SettingsRow
            title="Error"
            description={error}
            className="border-t border-destructive/30 bg-destructive/5 text-destructive"
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
