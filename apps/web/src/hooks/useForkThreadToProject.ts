import { scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useNewThreadHandler } from "./useHandleNewThread";

interface ForkThreadInput {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetProjectId: ProjectId;
  readonly targetProjectName: string;
  readonly modelSelection: ModelSelection;
  readonly note?: string;
}

/**
 * Hook for the "fork this conversation to another project" flow.
 *
 * Asks the server to summarise the SOURCE thread for an agent working in the
 * TARGET project, then drops the resulting handoff prompt into a new draft in
 * that target project and navigates there. Toasts cover the success and error
 * paths so the calling UI only has to provide a project selector.
 *
 * Same-environment only on purpose: forking across environments would require
 * shuttling the transcript across two WS connections, which is out of scope
 * here. The hook fails fast (and toasts) if source and target environments
 * differ, which prevents silent no-ops when the source-side fork is unsupported.
 */
export function useForkThreadToProject() {
  const { handleNewThread } = useNewThreadHandler();
  const [isForking, setIsForking] = useState(false);

  const forkThread = useCallback(
    async (input: ForkThreadInput): Promise<void> => {
      if (input.sourceEnvironmentId !== input.targetEnvironmentId) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Cross-environment fork is not supported",
            description: "Pick a project from the same environment as the source conversation.",
          }),
        );
        return;
      }

      const api = readEnvironmentApi(input.sourceEnvironmentId);
      if (!api) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Environment unavailable",
            description: "The source environment is not connected right now.",
          }),
        );
        return;
      }

      const progressToastId = toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Generating handoff…",
          description: `Summarising the conversation for ${input.targetProjectName}.`,
        }),
      );

      setIsForking(true);
      try {
        const handoff = await api.orchestration.generateThreadHandoff({
          sourceThreadId: input.sourceThreadId,
          targetProjectId: input.targetProjectId,
          modelSelection: input.modelSelection,
          ...(input.note !== undefined ? { note: input.note } : {}),
        });

        toastManager.close(progressToastId);

        await handleNewThread(scopeProjectRef(input.targetEnvironmentId, input.targetProjectId), {
          initialPrompt: handoff.prompt,
        });

        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: `Handoff drafted in ${input.targetProjectName}`,
            description: "Review and edit the summary before sending.",
          }),
        );
      } catch (error) {
        toastManager.close(progressToastId);
        const description =
          error instanceof Error ? error.message : "An unexpected error occurred.";
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to generate handoff",
            description,
          }),
        );
      } finally {
        setIsForking(false);
      }
    },
    [handleNewThread],
  );

  return { forkThread, isForking };
}
