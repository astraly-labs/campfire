import {
  ReviewLoopPrompt,
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
import {
  REVIEW_LOOP_MAX_REVIEWS,
  defaultReviewLoopPrompt,
} from "@t3tools/shared/pullRequestReviewLoop";
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
const isReviewLoopPrompt = Schema.is(ReviewLoopPrompt);

/**
 * Picks the reviewer and the prompt, then starts the loop from this thread. Mount it only while
 * it is open, so each open starts from the defaults. A pick always wins over the default, which
 * can change while the source thread streams.
 */
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
  /** False when the thread has not linked the pull request; the start links it. */
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
  const [prompt, setPrompt] = useState(() => defaultReviewLoopPrompt(pullRequest.number));
  const trimmedPrompt = prompt.trim();
  const promptValid = isReviewLoopPrompt(trimmedPrompt);
  const [starting, setStarting] = useState(false);
  const promptId = useId();
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
    if (reviewer === null || !promptValid || starting) return;
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
          prompt: trimmedPrompt,
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
            A second model reviews this pull request. This thread's agent fixes what it agrees with
            and pushes. Up to {REVIEW_LOOP_MAX_REVIEWS} reviews and {REVIEW_LOOP_MAX_REVIEWS - 1}{" "}
            fix rounds. You get a notification when the loop ends or needs you.
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
              <Label htmlFor={promptId}>Prompt</Label>
              <Textarea
                id={promptId}
                value={prompt}
                aria-invalid={!promptValid}
                disabled={starting}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                T3 Code adds the loop instructions after your prompt.
              </p>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={starting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={starting || reviewer === null || !promptValid}
            onClick={() => void start()}
          >
            {starting ? "Starting..." : "Start loop"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
