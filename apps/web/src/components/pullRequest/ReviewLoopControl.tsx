import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { reviewLoopStopInput } from "@t3tools/client-runtime/operations";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { reviewLoopChip, type ReviewLoopChip } from "@t3tools/shared/pullRequestReviewLoop";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, CircleStopIcon, RepeatIcon } from "lucide-react";
import { useState, type ComponentProps } from "react";

import { useServerConfigs, useThreadShell } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ReviewLoopDialog } from "./ReviewLoopDialog";
import {
  canStartReviewLoop,
  findReviewLoopLink,
  modelSelectionLabel,
  type ReviewLoopPullRequest,
} from "./reviewLoop.logic";

const CHIP_VARIANT = {
  working: "info",
  success: "success",
  warning: "warning",
  muted: "outline",
  error: "error",
} as const satisfies Record<ReviewLoopChip["tone"], ComponentProps<typeof Badge>["variant"]>;

/**
 * The review loop of one pull request beside one thread: its chip, whether the user can start or
 * stop a loop, and the start dialog for the caller to render.
 */
export function useReviewLoop(
  threadRef: ScopedThreadRef | null,
  pullRequest: ReviewLoopPullRequest,
) {
  const environmentId = threadRef?.environmentId ?? null;
  const configs = useServerConfigs();
  const config = environmentId === null ? undefined : configs.get(environmentId);
  const supported = config?.environment.capabilities.pullRequestReviewLoop === true;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const thread = useThreadShell(threadRef);
  const link = thread === null ? null : findReviewLoopLink(thread.pullRequests, pullRequest);
  const loop = supported ? link?.reviewLoop : undefined;
  const otherThreadId =
    loop === undefined ? null : loop.role === "author" ? loop.reviewThreadId : loop.sourceThreadId;
  const other = useThreadShell(
    environmentId === null || otherThreadId === null
      ? null
      : scopeThreadRef(environmentId, otherThreadId),
  );
  const chip =
    link === null || loop === undefined
      ? null
      : reviewLoopChip({
          link,
          sourceShell: loop.role === "reviewer" ? other : null,
          reviewerLabel:
            loop.role === "author" && other !== null
              ? modelSelectionLabel(config?.providers ?? [], other.modelSelection)
              : null,
        });
  const host = link?.host ?? pullRequest.host;
  const [dialogOpen, setDialogOpen] = useState(false);
  const navigate = useNavigate();
  const reviewLoop = useOrchestrationCommand(threadEnvironment.reviewLoop, {
    reportFailure: false,
  });

  const stop = async () => {
    if (threadRef === null || link === null) return;
    const input = reviewLoopStopInput(threadRef.threadId, link);
    if (input === undefined) return;
    const result = await reviewLoop({ environmentId: threadRef.environmentId, input });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not stop the review loop",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    chip,
    canStart:
      host !== undefined && canStartReviewLoop({ supported, canOperate, thread, pullRequest }),
    canStop: canOperate && chip?.live === true,
    openStartDialog: () => setDialogOpen(true),
    stop: () => void stop(),
    openOtherThread: () => {
      if (environmentId === null || chip === null) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, chip.otherThreadId)),
      });
    },
    dialog:
      dialogOpen && threadRef !== null && host !== undefined ? (
        <ReviewLoopDialog
          threadRef={threadRef}
          pullRequest={{
            host,
            repository: pullRequest.repository,
            number: pullRequest.number,
            url: link?.url ?? pullRequest.url,
          }}
          linked={link !== null}
          onClose={() => setDialogOpen(false)}
        />
      ) : null,
  };
}

export function reviewLoopOtherThreadLabel(chip: ReviewLoopChip): string {
  return chip.role === "author" ? "Open review thread" : "Open source thread";
}

export function ReviewLoopStatusChip({
  chip,
  ...props
}: { readonly chip: ReviewLoopChip } & Omit<ComponentProps<typeof Badge>, "variant">) {
  return (
    <Badge variant={CHIP_VARIANT[chip.tone]} {...props}>
      <RepeatIcon aria-hidden />
      {chip.label}
    </Badge>
  );
}

export function ReviewLoopControl({
  threadRef,
  pullRequest,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly pullRequest: ReviewLoopPullRequest;
}) {
  const loop = useReviewLoop(threadRef, pullRequest);
  const { chip } = loop;
  if (chip === null) {
    return loop.canStart ? (
      <>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                aria-label="Review loop"
                onClick={loop.openStartDialog}
              >
                <RepeatIcon aria-hidden className="size-3.5" />
                <span className="@max-[35rem]/pr-header:hidden">Review loop</span>
              </Button>
            }
          />
          <TooltipPopup>Have a second model review this pull request</TooltipPopup>
        </Tooltip>
        {loop.dialog}
      </>
    ) : null;
  }
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <ReviewLoopStatusChip
              chip={chip}
              size="control"
              aria-label={`Review loop: ${chip.label}`}
              render={<button type="button" />}
            />
          }
        />
        <MenuPopup align="end" side="bottom">
          <MenuGroup>
            <MenuGroupLabel className="max-w-64">{chip.detail}</MenuGroupLabel>
            <MenuItem onClick={loop.openOtherThread}>
              <ArrowUpRightIcon />
              {reviewLoopOtherThreadLabel(chip)}
            </MenuItem>
            {loop.canStop ? (
              <MenuItem onClick={loop.stop}>
                <CircleStopIcon />
                Stop loop
              </MenuItem>
            ) : null}
            {!chip.live && loop.canStart ? (
              <MenuItem onClick={loop.openStartDialog}>
                <RepeatIcon />
                Start new loop...
              </MenuItem>
            ) : null}
          </MenuGroup>
        </MenuPopup>
      </Menu>
      {loop.dialog}
    </>
  );
}
