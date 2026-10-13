import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { MessageCircleIcon, LockKeyholeIcon } from "lucide-react";
import { MessageId, ThreadId, type ModelSelection, type OrchestrationV2ThreadProjection, type ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import type { EnvironmentProject, EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useGoogleTeam } from "./googleTeam";
import { SideThreadDrawer } from "../sidethread/SideThreadDrawer";
import { TakeALookButton } from "../sidethread/TakeALookButton";
import { QuoteOnSelection } from "../sidethread/QuoteOnSelection";
import { useSideThreadUiStore } from "../sidethread/sideThreadUiStore";
import { PresenceAvatarStack } from "../presence/PresenceAvatarStack";
import { useThreadPresence } from "../presence/presence";
import { ThreadBriefingView } from "../components/context-assistant/ThreadBriefingView";
import { PullRequestReviewDialog } from "../components/PullRequestReviewDialog";
import { Button } from "../components/ui/button";
import { Sheet, SheetPopup, SheetHeader, SheetTitle, SheetDescription } from "../components/ui/sheet";
import { threadEnvironment } from "../state/threads";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { randomUUID } from "../lib/utils";
import { toastManager } from "../components/ui/toast";

import { ThreadCollaborationContext, useThreadCollaboration, type CollaborationContext } from "./threadCollaborationContext";

export function ThreadCollaborationProvider(props: {
  readonly thread: EnvironmentThreadShell;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly project: EnvironmentProject | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly cwd: string | undefined;
  readonly children: ReactNode;
}) {
  const { thread, projection, project } = props;
  const threadRef = useMemo(() => scopeThreadRef(thread.environmentId, thread.id), [thread.environmentId, thread.id]);
  const team = useGoogleTeam(thread.environmentId);
  const [discussion, setDiscussion] = useState<{ messageId: MessageId | null; quote: string } | null>(null);
  const [reviewNumber, setReviewNumber] = useState<number | null>(null);
  const [startingReview, setStartingReview] = useState(false);
  const reviewInFlight = useRef(false);
  const requestedThreadKey = useSideThreadUiStore((state) => state.requestedThreadKey);
  const consumeRequest = useSideThreadUiStore((state) => state.consumeOpenRequest);
  const threadKey = scopedThreadKey(threadRef);
  const navigate = useNavigate();
  const briefingOpen = useSearch({ strict: false, select: (search) => search.view === "briefing" });
  const setBriefingOpen = useCallback((open: boolean) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: open ? { view: "briefing" } : {},
      replace: true,
    });
  }, [navigate, threadRef]);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const create = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const remove = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  useEffect(() => {
    if (requestedThreadKey !== threadKey) return;
    setDiscussion({ messageId: null, quote: "" });
    consumeRequest(threadKey);
  }, [requestedThreadKey, threadKey, consumeRequest]);
  const sideThread = projection?.sideThreads?.find((entry) => entry.id === sideThreadIdForThread(thread.id));
  const latest = sideThread?.messages.at(-1);
  const readAt = sideThread?.readBy?.find((marker) => marker.user.subject === team.current?.subject)?.lastReadAt;
  const unread = discussion === null && latest !== undefined && team.current !== null && latest.author.subject !== team.current.subject && (readAt === undefined || latest.createdAt > readAt);
  const context = useMemo<CollaborationContext>(() => ({
    threadRef, team, unread, messageCount: sideThread?.messages.length ?? 0,
    open: (messageId, quote = "") => setDiscussion({ messageId: messageId ?? null, quote }),
    review: setReviewNumber,
    openBriefing: () => setBriefingOpen(true),
  }), [threadRef, team, unread, sideThread?.messages.length, setBriefingOpen]);
  const startReview = async (modelSelection: ModelSelection) => {
    if (!project || reviewNumber === null || reviewInFlight.current) return;
    reviewInFlight.current = true;
    setStartingReview(true);
    const id = ThreadId.make(randomUUID());
    const title = `Review PR #${reviewNumber}`;
    let created = false;
    try {
      const updated = await updateProject({ environmentId: thread.environmentId, input: { projectId: project.id, defaultReviewModelSelection: modelSelection } });
      if (updated._tag === "Failure") throw squashAtomCommandFailure(updated);
      const result = await create({ environmentId: thread.environmentId, input: {
        threadId: id, projectId: project.id, title, modelSelection, runtimeMode: thread.runtimeMode,
        interactionMode: "default", kind: "review", reviewPullRequestNumber: reviewNumber,
        branch: thread.branch, worktreePath: thread.worktreePath,
      } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      created = true;
      const started = await start({ environmentId: thread.environmentId, input: {
        threadId: id, message: { messageId: MessageId.make(randomUUID()), role: "user", text: `/review #${reviewNumber}`, attachments: [] },
        modelSelection, runtimeMode: thread.runtimeMode, interactionMode: "default", titleSeed: title,
      } });
      if (started._tag === "Failure") {
        await remove({ environmentId: thread.environmentId, input: { threadId: id } });
        throw squashAtomCommandFailure(started);
      }
      setReviewNumber(null);
      await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, id)) });
    } catch (error) {
      toastManager.add({ type: "error", title: created ? "Could not start review" : "Could not create review", description: error instanceof Error ? error.message : String(error) });
    } finally {
      reviewInFlight.current = false;
      setStartingReview(false);
    }
  };
  return <ThreadCollaborationContext value={projection ? context : null}>
    {props.children}
    {projection ? <SideThreadDrawer environmentId={thread.environmentId} threadId={thread.id} thread={projection} team={team.members} currentSubject={team.current?.subject ?? null} open={discussion !== null} contextMessageId={discussion?.messageId ?? null} draftPrefill={discussion?.quote ?? ""} onClose={() => setDiscussion(null)} /> : null}
    <Sheet open={briefingOpen} onOpenChange={setBriefingOpen}>
      <SheetPopup side="right" className="sm:max-w-2xl">
        <SheetHeader><SheetTitle>Private briefing</SheetTitle><SheetDescription>Ask about this thread without posting to its shared conversation.</SheetDescription></SheetHeader>
        <div data-slot="sheet-panel" className="flex min-h-0 flex-1 flex-col px-6 pb-6">
          {briefingOpen ? <ThreadBriefingView environmentId={thread.environmentId} sourceThreadId={thread.id} threadRef={threadRef} cwd={props.cwd} hidden={false} /> : null}
        </div>
      </SheetPopup>
    </Sheet>
    {project && reviewNumber !== null ? <PullRequestReviewDialog open environmentId={thread.environmentId} pullRequestNumber={reviewNumber} defaultModelSelection={project.defaultReviewModelSelection ?? project.defaultModelSelection ?? thread.modelSelection} providers={props.providers} settings={props.settings} isStarting={startingReview} onOpenChange={(open) => { if (!open) setReviewNumber(null); }} onStart={(selection) => void startReview(selection)} /> : null}
  </ThreadCollaborationContext>;
}

export function ThreadCollaborationToolbar() {
  const context = useThreadCollaboration();
  return context ? <CollaborationToolbar context={context} /> : null;
}
function CollaborationToolbar({ context }: { readonly context: CollaborationContext }) {
  const viewers = useThreadPresence(context.threadRef.environmentId, context.threadRef.threadId);
  return <div className="flex shrink-0 items-center gap-1">
    <PresenceAvatarStack viewers={viewers} />
    <Button size="icon-sm" variant="ghost" aria-label={context.unread ? "Open unread team discussion" : "Open team discussion"} onClick={() => context.open()}>
      <MessageCircleIcon className={context.unread ? "size-4 text-primary" : "size-4"} />
      {context.messageCount > 0 ? <span className="text-[10px]">{context.messageCount > 99 ? "99+" : context.messageCount}</span> : null}
    </Button>
    <Button size="icon-sm" variant="ghost" aria-label="Open private briefing" onClick={context.openBriefing}><LockKeyholeIcon className="size-4" /></Button>
  </div>;
}
export function TeamMessageActions({ messageId }: { readonly messageId: MessageId }) {
  const context = useThreadCollaboration();
  if (!context) return null;
  return <div className="flex items-center gap-1 px-1">
    <Button size="xs" variant="ghost" onClick={() => context.open(messageId)}><MessageCircleIcon className="size-3" />Discuss</Button>
    <TakeALookButton environmentId={context.threadRef.environmentId} threadId={context.threadRef.threadId} messageId={messageId} team={context.team.members} currentSubject={context.team.current?.subject ?? null} onOpenSideThread={context.open} />
  </div>;
}
export function TeamQuoteSelection({ messageId, children }: { readonly messageId: MessageId; readonly children: ReactNode }) {
  const context = useThreadCollaboration();
  return context ? <QuoteOnSelection onQuote={(quote) => context.open(messageId, quote)}>{children}</QuoteOnSelection> : children;
}
