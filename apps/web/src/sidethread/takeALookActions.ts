import {
  CommandId,
  type EnvironmentApi,
  type MessageId,
  type SideThreadId,
  type SideThreadMessageId,
  type ThreadId,
  type UserRef,
} from "@t3tools/contracts";

import { mentionHandleForUser } from "../inbox/mentionAutocomplete";
import { deriveSideThreadId } from "./sideThreadStore";

export interface TakeALookParams {
  readonly api: EnvironmentApi;
  readonly currentUser: UserRef;
  readonly targets: ReadonlyArray<UserRef>;
  readonly parentThreadId: ThreadId;
  readonly anchorMessageId: MessageId;
}

/**
 * "Take a look" ping — posts a short `@user please take a look!` message in
 * the side-thread anchored to the given assistant message, mentioning the
 * selected teammates. Idempotently creates the side-thread first; mention
 * recipients get the badge via the existing inbox subscription.
 *
 * Returns once both commands have been dispatched. Callers should surface
 * errors via toast (the `sidethread.create` already-exists case is swallowed
 * here on purpose).
 */
export async function takeALook(params: TakeALookParams): Promise<void> {
  const targets = dedupeById(params.targets);
  if (targets.length === 0) {
    throw new Error("takeALook: at least one target is required");
  }

  const sideThreadId = deriveSideThreadId({
    parentThreadId: params.parentThreadId,
    anchorMessageId: params.anchorMessageId,
  }) as SideThreadId;

  await params.api.sideThread
    .dispatchCommand({
      type: "sidethread.create",
      commandId: CommandId.make(`st-create:${sideThreadId}:${Date.now()}`),
      sideThreadId,
      parentThreadId: params.parentThreadId,
      anchor: { kind: "message", messageId: params.anchorMessageId },
      createdBy: params.currentUser,
    })
    .catch(() => {
      // Already exists → ignore. Mirrors SideThreadDrawer's create handling.
    });

  const text = buildTakeALookText(targets);
  const messageId = `${sideThreadId}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}` as SideThreadMessageId;

  await params.api.sideThread.dispatchCommand({
    type: "sidethread.message.post",
    commandId: CommandId.make(`st-post:${sideThreadId}:${Date.now()}`),
    sideThreadId,
    messageId,
    author: params.currentUser,
    text,
    mentions: targets,
  });
}

/**
 * Pure for testability. Produces e.g. `@alice @bob please take a look!`.
 */
export function buildTakeALookText(targets: ReadonlyArray<UserRef>): string {
  const handles = targets.map((u) => `@${mentionHandleForUser(u)}`).join(" ");
  return `${handles} please take a look!`;
}

function dedupeById(users: ReadonlyArray<UserRef>): ReadonlyArray<UserRef> {
  const seen = new Set<string>();
  const out: UserRef[] = [];
  for (const u of users) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out.push(u);
  }
  return out;
}
