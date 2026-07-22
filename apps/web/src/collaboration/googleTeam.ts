import type { AuthClientSession, EnvironmentId, SideThreadAuthor } from "@t3tools/contracts";
import { useMemo } from "react";

import { authEnvironment } from "../state/auth";
import { useEnvironmentQuery } from "../state/query";

export interface GoogleTeamMember extends SideThreadAuthor {
  readonly current: boolean;
  readonly connected: boolean;
}

export function googleTeamMembersFromSessions(
  sessions: ReadonlyArray<AuthClientSession>,
): ReadonlyArray<GoogleTeamMember> {
  const bySubject = new Map<string, GoogleTeamMember>();
  for (const session of sessions) {
    if (!session.subject.startsWith("google:")) continue;
    const displayName = session.client.label?.trim() || session.subject;
    const previous = bySubject.get(session.subject);
    bySubject.set(session.subject, {
      subject: session.subject,
      displayName:
        previous && previous.displayName !== previous.subject ? previous.displayName : displayName,
      current: (previous?.current ?? false) || session.current,
      connected: (previous?.connected ?? false) || session.connected,
    });
  }
  return [...bySubject.values()].toSorted(
    (left, right) =>
      Number(right.connected) - Number(left.connected) ||
      left.displayName.localeCompare(right.displayName) ||
      left.subject.localeCompare(right.subject),
  );
}

export function useGoogleTeam(environmentId: EnvironmentId | null) {
  const access = useEnvironmentQuery(
    environmentId === null ? null : authEnvironment.accessChanges({ environmentId, input: null }),
  );
  const members = useMemo(() => {
    const event = access.data;
    return event?.type === "snapshot"
      ? googleTeamMembersFromSessions(event.payload.clientSessions)
      : [];
  }, [access.data]);
  const current = members.find((member) => member.current) ?? null;
  return {
    members,
    current,
    error: access.error,
    isPending: access.isPending,
  } as const;
}
