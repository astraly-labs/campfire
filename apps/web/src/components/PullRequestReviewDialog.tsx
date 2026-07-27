import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { useEffect, useMemo, useState } from "react";

import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "../modelSelection";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "../providerInstances";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

interface PullRequestReviewDialogProps {
  open: boolean;
  pullRequestNumber: number;
  defaultModelSelection: ModelSelection;
  providers: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
  isStarting: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (modelSelection: ModelSelection) => void;
}

export function PullRequestReviewDialog({
  open,
  pullRequestNumber,
  defaultModelSelection,
  providers,
  settings,
  isStarting,
  onOpenChange,
  onStart,
}: PullRequestReviewDialogProps) {
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)).filter(
        (entry) => entry.enabled && entry.isAvailable && entry.status === "ready",
      ),
    [providers],
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
  const resolvedDefaultSelection = useMemo(() => {
    const requestedEntry = instanceEntries.find(
      (entry) => entry.instanceId === defaultModelSelection.instanceId,
    );
    const entry = requestedEntry ?? instanceEntries[0];
    if (!entry) {
      return defaultModelSelection;
    }
    const model =
      resolveAppModelSelectionForInstance(
        entry.instanceId,
        settings,
        providers,
        requestedEntry ? defaultModelSelection.model : null,
      ) ?? defaultModelSelection.model;
    return createModelSelection(
      entry.instanceId,
      model,
      requestedEntry ? defaultModelSelection.options : undefined,
    );
  }, [defaultModelSelection, instanceEntries, providers, settings]);
  const [modelSelection, setModelSelection] = useState(resolvedDefaultSelection);

  useEffect(() => {
    if (open) {
      setModelSelection(resolvedDefaultSelection);
    }
  }, [open, pullRequestNumber, resolvedDefaultSelection]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isStarting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Review PR #{pullRequestNumber}</DialogTitle>
          <DialogDescription>
            Start a new conversation and run <code>/review #{pullRequestNumber}</code>. Your
            selection is saved as this project's review model.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Review model</span>
            <ProviderModelPicker
              activeInstanceId={modelSelection.instanceId}
              model={modelSelection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerVariant="outline"
              triggerClassName="w-full max-w-none text-foreground/90 hover:text-foreground"
              disabled={isStarting || instanceEntries.length === 0}
              onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) => {
                setModelSelection(createModelSelection(instanceId, model));
              }}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={isStarting} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={isStarting || instanceEntries.length === 0}
            onClick={() => onStart(modelSelection)}
          >
            {isStarting ? "Starting…" : "Start review"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
