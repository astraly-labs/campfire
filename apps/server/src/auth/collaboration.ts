import type { CollaborationUser } from "@t3tools/contracts";

import type { AuthenticatedSession } from "./EnvironmentAuth.ts";

type CollaborationPrincipal = Pick<AuthenticatedSession, "subject" | "displayName">;

export function authenticatedCollaborationUser(
  principal: CollaborationPrincipal,
): CollaborationUser | null {
  return principal.subject.startsWith("google:")
    ? { subject: principal.subject, displayName: principal.displayName ?? principal.subject }
    : null;
}

/** Stamp trusted identity after the payload so a client cannot impersonate a teammate. */
export function withAuthenticatedCollaboration<T extends object>(
  payload: T,
  principal: CollaborationPrincipal,
): T & { readonly collaborationUser: CollaborationUser | null } {
  return { ...payload, collaborationUser: authenticatedCollaborationUser(principal) };
}
