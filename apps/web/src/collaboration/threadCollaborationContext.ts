import { createContext, use } from "react";
import type { AssistantCitation, MessageId, ScopedThreadRef } from "@t3tools/contracts";
import type { useGoogleTeam } from "./googleTeam";

export interface CollaborationContext {
  readonly threadRef: ScopedThreadRef;
  readonly team: ReturnType<typeof useGoogleTeam>;
  readonly open: (messageId?: MessageId) => void;
  /** Opens the team discussion with the selected agent text as the draft's quote. */
  readonly quote: (citation: AssistantCitation) => void;
  readonly review: (number: number) => void;
  readonly openBriefing: () => void;
  readonly unread: boolean;
  readonly messageCount: number;
}
export const ThreadCollaborationContext = createContext<CollaborationContext | null>(null);
export const useThreadCollaboration = () => use(ThreadCollaborationContext);
