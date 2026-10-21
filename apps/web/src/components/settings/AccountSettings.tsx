import { useState } from "react";

import { useGoogleTeam } from "../../collaboration/googleTeam";
import { signOutOfPrimaryEnvironment } from "../../environments/primary";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Shown only for a Google sign-in, the one session a browser can end and start again. */
export function AccountSettings() {
  const team = useGoogleTeam(usePrimaryEnvironmentId());
  const [signingOut, setSigningOut] = useState(false);
  const current = team.current;
  if (current === null) return null;

  const signOut = async () => {
    setSigningOut(true);
    try {
      await signOutOfPrimaryEnvironment();
      window.location.assign("/");
    } catch (error) {
      setSigningOut(false);
      toastManager.add({
        type: "error",
        title: "Could not sign out",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  return (
    <SettingsSection id="account" title="Account">
      <SettingsRow
        id="sign-out"
        title={`Signed in as ${current.displayName}`}
        description="Sign out of Campfire in this browser. You can sign in again with Google."
        control={
          <Button disabled={signingOut} onClick={() => void signOut()} size="sm" variant="outline">
            {signingOut ? "Signing out..." : "Sign out"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
