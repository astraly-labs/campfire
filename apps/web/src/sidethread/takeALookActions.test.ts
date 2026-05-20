import type {
  EnvironmentApi,
  MessageId,
  SideThreadCommand,
  SideThreadDispatchResult,
  ThreadId,
  UserRef,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildTakeALookText, takeALook } from "./takeALookActions";

const mkUser = (id: string, displayName: string): UserRef => ({
  id: id as UserRef["id"],
  displayName: displayName as UserRef["displayName"],
});

const ALICE = mkUser("user-alice", "Alice");
const BOB = mkUser("user-bob", "Bob");
const CARL = mkUser("user-carl", "Carl");
const SELF = mkUser("user-self", "Self");

const PARENT_THREAD_ID = "thread-123" as ThreadId;
const QUOTED_MESSAGE_ID = "msg-456" as MessageId;

const ACCEPTED: SideThreadDispatchResult = {
  acceptedAt: "2026-05-19T00:00:00.000Z" as SideThreadDispatchResult["acceptedAt"],
  events: [],
};

function makeApiMock(opts?: { createRejects?: boolean }): {
  api: EnvironmentApi;
  dispatched: SideThreadCommand[];
} {
  const dispatched: SideThreadCommand[] = [];
  const dispatchCommand = vi.fn(async (command: SideThreadCommand) => {
    dispatched.push(command);
    if (opts?.createRejects && command.type === "sidethread.create") {
      throw new Error("already exists");
    }
    return ACCEPTED;
  });
  const api = {
    sideThread: { dispatchCommand },
    // The action only touches `sideThread.dispatchCommand`. Cast keeps the
    // mock minimal without forcing us to stub every EnvironmentApi surface.
  } as unknown as EnvironmentApi;
  return { api, dispatched };
}

describe("buildTakeALookText", () => {
  it("formats a single target", () => {
    expect(buildTakeALookText([ALICE])).toBe("@alice please take a look!");
  });

  it("joins multiple handles with a single space and keeps order", () => {
    expect(buildTakeALookText([ALICE, BOB, CARL])).toBe("@alice @bob @carl please take a look!");
  });
});

describe("takeALook", () => {
  it("dispatches create then post with the expected payload (single target)", async () => {
    const { api, dispatched } = makeApiMock();

    await takeALook({
      api,
      currentUser: SELF,
      targets: [ALICE],
      parentThreadId: PARENT_THREAD_ID,
      quotedMessageId: QUOTED_MESSAGE_ID,
    });

    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.type).toBe("sidethread.create");
    const post = dispatched[1];
    if (post?.type !== "sidethread.message.post") {
      throw new Error("expected post command");
    }
    expect(post.text).toBe("@alice please take a look!");
    expect(post.mentions).toEqual([ALICE]);
    expect(post.author).toEqual(SELF);
  });

  it("posts a single message with all mentions when targets > 1", async () => {
    const { api, dispatched } = makeApiMock();

    await takeALook({
      api,
      currentUser: SELF,
      targets: [ALICE, BOB, CARL],
      parentThreadId: PARENT_THREAD_ID,
      quotedMessageId: QUOTED_MESSAGE_ID,
    });

    const posts = dispatched.filter((c) => c.type === "sidethread.message.post");
    expect(posts).toHaveLength(1);
    const post = posts[0];
    if (post?.type !== "sidethread.message.post") throw new Error("unreachable");
    expect(post.text).toBe("@alice @bob @carl please take a look!");
    expect(post.mentions).toEqual([ALICE, BOB, CARL]);
  });

  it("deduplicates targets by id before posting", async () => {
    const { api, dispatched } = makeApiMock();

    await takeALook({
      api,
      currentUser: SELF,
      targets: [ALICE, ALICE, BOB],
      parentThreadId: PARENT_THREAD_ID,
      quotedMessageId: QUOTED_MESSAGE_ID,
    });

    const post = dispatched.find((c) => c.type === "sidethread.message.post");
    if (post?.type !== "sidethread.message.post") throw new Error("expected post");
    expect(post.mentions).toEqual([ALICE, BOB]);
    expect(post.text).toBe("@alice @bob please take a look!");
  });

  it("still posts when sidethread.create rejects (already-exists path)", async () => {
    const { api, dispatched } = makeApiMock({ createRejects: true });

    await expect(
      takeALook({
        api,
        currentUser: SELF,
        targets: [ALICE],
        parentThreadId: PARENT_THREAD_ID,
        quotedMessageId: QUOTED_MESSAGE_ID,
      }),
    ).resolves.toBeUndefined();

    expect(dispatched.map((c) => c.type)).toEqual(["sidethread.create", "sidethread.message.post"]);
  });

  it("throws when no targets are provided", async () => {
    const { api } = makeApiMock();

    await expect(
      takeALook({
        api,
        currentUser: SELF,
        targets: [],
        parentThreadId: PARENT_THREAD_ID,
        quotedMessageId: QUOTED_MESSAGE_ID,
      }),
    ).rejects.toThrow(/at least one target/i);
  });
});
