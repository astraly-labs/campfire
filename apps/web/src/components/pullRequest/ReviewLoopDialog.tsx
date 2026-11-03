import {
  ReviewLoopNote,
  type ModelSelection,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createModelSelection, modelSelectionsEqual } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useId, useMemo, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "~/modelSelection";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "~/providerInstances";
import { readThreadShell, useProject, useServerConfigs, useThreadShell } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  defaultReviewLoopReviewer,
  findReviewLoopLink,
  type ReviewLoopPullRequest,
} from "./reviewLoop.logic";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const isReviewLoopNote = Schema.is(ReviewLoopNote);

/** A pick always wins over the default reviewer, which can change while the source thread streams. */
export function ReviewLoopDialog({
  threadRef,
  pullRequest,
  linked,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly pullRequest: Pick<ReviewLoopPullRequest, "repository" | "number" | "url"> & {
    readonly host: string;
  };
  readonly linked: boolean;
  readonly onClose: () => void;
}) {
  const { environmentId } = threadRef;
  const navigate = useNavigate();
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  const providers = useServerConfigs().get(environmentId)?.providers ?? EMPTY_PROVIDERS;
  const settings = useEnvironmentSettings(environmentId);
  const allEntries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)),
    [providers],
  );
  const instanceEntries = useMemo(
    () =>
      allEntries.filter((entry) => entry.enabled && entry.isAvailable && entry.status === "ready"),
    [allEntries],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      new Map(
        instanceEntries.map((entry) => [
          entry.instanceId,
          getAppModelOptionsForInstance(settings, entry),
        ]),
      ),
    [instanceEntries, settings],
  );
  const sourceSelection = thread?.modelSelection ?? null;
  const projectReviewer = project?.defaultReviewModelSelection ?? null;
  const defaultReviewer = useMemo(() => {
    if (sourceSelection === null) return null;
    const seed = defaultReviewLoopReviewer({
      projectReviewer,
      source: sourceSelection,
      sourceDriver:
        allEntries.find((entry) => entry.instanceId === sourceSelection.instanceId)?.driverKind ??
        null,
      readyInstances: instanceEntries,
    });
    if (seed === null) return null;
    const model = resolveAppModelSelectionForInstance(
      seed.instanceId,
      settings,
      providers,
      seed.selection?.model ?? null,
    );
    return model === null
      ? seed.selection
      : createModelSelection(seed.instanceId, model, seed.selection?.options);
  }, [allEntries, instanceEntries, projectReviewer, providers, settings, sourceSelection]);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const reviewer = picked ?? defaultReviewer;
  const reviewerEntry =
    reviewer === null
      ? undefined
      : instanceEntries.find((entry) => entry.instanceId === reviewer.instanceId);
  const [note, setNote] = useState("");
  const trimmedNote = note.trim();
  const noteValid = trimmedNote === "" || isReviewLoopNote(trimmedNote);
  const [starting, setStarting] = useState(false);
  const noteId = useId();
  const reviewLoop = useOrchestrationCommand(threadEnvironment.reviewLoop, {
    reportFailure: false,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });

  const openReviewThread = () => {
    const source = readThreadShell(threadRef);
    const loop =
      source === null
        ? undefined
        : findReviewLoopLink(source.pullRequests, pullRequest)?.reviewLoop;
    if (loop?.role !== "author") return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, loop.reviewThreadId)),
    });
  };

  const start = async () => {
    if (reviewer === null || !noteValid || starting) return;
    setStarting(true);
    const result = await reviewLoop({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        host: pullRequest.host,
        repository: pullRequest.repository,
        number: pullRequest.number,
        request: {
          type: "start",
          reviewer,
          budget: 3,
          ...(trimmedNote === "" ? {} : { note: trimmedNote }),
          ...(linked ? {} : { link: { url: pullRequest.url, source: "manual" } }),
        },
      },
    });
    setStarting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not start the review loop",
          description: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    onClose();
    const toastId = toastManager.add({
      type: "success",
      title: "Review loop started",
      actionProps: {
        children: "Open review thread",
        onClick: () => {
          toastManager.close(toastId);
          openReviewThread();
        },
      },
    });
    if (
      project !== null &&
      (project.defaultReviewModelSelection == null ||
        !modelSelectionsEqual(project.defaultReviewModelSelection, reviewer))
    ) {
      void updateProject({
        environmentId,
        input: { projectId: project.id, defaultReviewModelSelection: reviewer },
      });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !starting) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Review loop for #{pullRequest.number}</DialogTitle>
          <DialogDescription>
            A second model reviews your local checkout of this pull request. This thread's agent
            answers each review. Nothing is pushed until the reviewer approves. Then the agent
            pushes once and notes the review in the pull request. You get a notification when the
            loop ends or needs you.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Reviewer</Label>
              {reviewer === null ? (
                <p className="text-sm text-muted-foreground">No provider is ready to review.</p>
              ) : (
                <div className="flex min-w-0 items-center gap-1.5">
                  <ProviderModelPicker
                    environmentId={environmentId}
                    isComposerOwned={false}
                    activeInstanceId={reviewer.instanceId}
                    model={reviewer.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerClassName="min-w-0 max-w-none flex-1 text-foreground/90 hover:text-foreground"
                    disabled={starting}
                    onInstanceModelChange={(instanceId, model) => {
                      setPicked(createModelSelection(instanceId, model));
                    }}
                  />
                  {reviewerEntry === undefined ? null : (
                    <TraitsPicker
                      provider={reviewerEntry.driverKind}
                      models={reviewerEntry.models}
                      model={reviewer.model}
                      prompt=""
                      onPromptChange={() => {}}
                      modelOptions={reviewer.options ?? []}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={settings.planModeEnabled}
                      disabled={starting}
                      onModelOptionsChange={(options) => {
                        setPicked(
                          createModelSelection(reviewer.instanceId, reviewer.model, options),
                        );
                      }}
                    />
                  )}
                </div>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={noteId}>Notes for the reviewer (optional)</Label>
              <Textarea
                id={noteId}
                value={note}
                aria-invalid={!noteValid}
                disabled={starting}
                onChange={(event) => setNote(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The reviewer gets your note word for word with the first review.
              </p>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={starting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={starting || reviewer === null || !noteValid}
            onClick={() => void start()}
          >
            {starting ? "Starting..." : "Start loop"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
