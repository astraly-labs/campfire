import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { selectThreadByRef, useStore } from "../store";
import { buildBranchSeedPrompt } from "./branchThreadTranscript";
import { useNewThreadHandler } from "./useHandleNewThread";

interface BranchThreadInput {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetProjectId: ProjectId;
  readonly targetProjectName: string;
}

/**
 * "Branch this conversation" — sibling to {@link useForkThreadToProject},
 * but with no LLM round-trip. Reads the source transcript from the local
 * store, formats it verbatim with role labels, and seeds a fresh draft in
 * the target project with that body as its initial prompt.
 *
 * Why a separate hook from fork-handoff:
 * - Fork (handoff) compresses with an LLM — good when you want a clean
 *   restart in a different project.
 * - Branch (here) keeps every word — good when you want the next agent (or
 *   yourself, an hour from now) to read what was actually said, especially
 *   when subtle wording matters (debug findings, exact file paths, etc.).
 *
 * Same-environment only on purpose: the source transcript lives on the
 * source-side WS connection, so we cannot reconstruct it for a target in a
 * different environment without a server-side relay.
 */
export function useBranchThreadToProject() {
  const { handleNewThread } = useNewThreadHandler();
  const store = useStore;

  const branchThread = useCallback(
    async (input: BranchThreadInput): Promise<void> => {
      if (input.sourceEnvironmentId !== input.targetEnvironmentId) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Cross-environment branch is not supported",
            description: "Pick a project from the same environment as the source conversation.",
          }),
        );
        return;
      }

      // Pull the source thread from the store at action time so we always
      // copy the freshest transcript the client has seen. Reading inside
      // the callback (instead of via a selector subscription) avoids
      // re-creating `branchThread` on every transcript tick.
      const sourceThread = selectThreadByRef(
        store.getState(),
        scopeThreadRef(input.sourceEnvironmentId, input.sourceThreadId),
      );
      if (!sourceThread) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Source thread is not loaded",
            description: "Open the conversation once before branching it.",
          }),
        );
        return;
      }

      const seed = buildBranchSeedPrompt(sourceThread.messages);
      if (!seed) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Nothing to branch yet",
            description: "This conversation has no messages to copy.",
          }),
        );
        return;
      }

      await handleNewThread(scopeProjectRef(input.targetEnvironmentId, input.targetProjectId), {
        initialPrompt: seed,
      });

      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: `Branched into ${input.targetProjectName}`,
          description: "Transcript copied as the first message — edit before sending.",
        }),
      );
    },
    [handleNewThread, store],
  );

  return { branchThread };
}
