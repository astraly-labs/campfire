import { useMemo } from "react";

import { useGoogleTeam } from "../collaboration/googleTeam";
import { useThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { deriveTeamInboxItems } from "./teamInbox";

export function useTeamInboxItems() {
  const environmentId = usePrimaryEnvironmentId();
  const team = useGoogleTeam(environmentId);
  const threads = useThreadShells();
  const currentSubject = team.current?.subject ?? null;
  return useMemo(
    () => deriveTeamInboxItems({ threads, environmentId, currentSubject }),
    [threads, environmentId, currentSubject],
  );
}
