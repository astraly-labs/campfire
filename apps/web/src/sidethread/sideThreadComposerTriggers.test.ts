import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  detectSideThreadTrigger,
  linkedThreadForText,
  matchThreadLinkItems,
  suggestionToken,
  type ThreadLinkCandidate,
} from "./sideThreadComposerTriggers";

describe("detectSideThreadTrigger", () => {
  it("opens teammate mentions on @ and thread links on #, with the query up to the caret", () => {
    expect(detectSideThreadTrigger("ping @ja", 8)).toEqual({
      kind: "mention",
      query: "ja",
      rangeStart: 5,
      rangeEnd: 8,
    });
    expect(detectSideThreadTrigger("see #log", 8)).toEqual({
      kind: "thread",
      query: "log",
      rangeStart: 4,
      rangeEnd: 8,
    });
  });

  it("opens on a bare trigger so the menu lists everything", () => {
    expect(detectSideThreadTrigger("#", 1)).toMatchObject({ kind: "thread", query: "" });
    expect(detectSideThreadTrigger("@", 1)).toMatchObject({ kind: "mention", query: "" });
  });

  it("reads the token under the caret, not the end of the text", () => {
    expect(detectSideThreadTrigger("@jan and more", 4)).toMatchObject({
      kind: "mention",
      query: "jan",
    });
  });

  it("stays closed outside a token that starts with a trigger", () => {
    expect(detectSideThreadTrigger("mail a@b.co", 11)).toBeNull();
    expect(detectSideThreadTrigger("in C#", 5)).toBeNull();
    expect(detectSideThreadTrigger("@jane ", 6)).toBeNull();
    expect(detectSideThreadTrigger("$skill", 6)).toBeNull();
    expect(detectSideThreadTrigger("/model", 6)).toBeNull();
  });
});

describe("matchThreadLinkItems", () => {
  const environmentId = EnvironmentId.make("env-1");
  const thread = (
    id: string,
    overrides: Partial<ThreadLinkCandidate> = {},
  ): ThreadLinkCandidate => ({
    environmentId,
    id: ThreadId.make(id),
    title: `Thread ${id}`,
    updatedAt: "2026-10-20T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    ...overrides,
  });
  const match = (threads: ReadonlyArray<ThreadLinkCandidate>, query = "") =>
    matchThreadLinkItems({
      threads,
      environmentId,
      excludeThreadId: ThreadId.make("current"),
      query,
    }).map((item) => (item.type === "thread" ? item.thread.threadId : null));

  it("offers only active threads from this environment, never the current one", () => {
    expect(
      match([
        thread("current"),
        thread("other-env", { environmentId: EnvironmentId.make("env-2") }),
        thread("archived", { archivedAt: "2026-10-21T10:00:00.000Z" }),
        thread("settled", { settledOverride: "settled" }),
        thread("unsettled", { settledOverride: "active" }),
        thread("plain"),
      ]),
    ).toEqual(["unsettled", "plain"]);
  });

  it("puts the most recently updated threads first", () => {
    expect(
      match([
        thread("old", { updatedAt: "2026-10-01T10:00:00.000Z" }),
        thread("new", { updatedAt: "2026-10-23T10:00:00.000Z" }),
      ]),
    ).toEqual(["new", "old"]);
  });

  it("filters by title, ignoring case", () => {
    expect(
      match(
        [thread("a", { title: "Fix login bug" }), thread("b", { title: "Billing export" })],
        "LOGIN",
      ),
    ).toEqual(["a"]);
  });

  it("links with a readable token", () => {
    const [item] = matchThreadLinkItems({
      threads: [thread("a", { title: "Fix login bug" })],
      environmentId,
      excludeThreadId: ThreadId.make("current"),
      query: "",
    });
    expect(item && suggestionToken(item)).toBe("#Fix login bug ");
  });
});

describe("linkedThreadForText", () => {
  const login = { threadId: ThreadId.make("login"), title: "Fix login bug" };
  const billing = { threadId: ThreadId.make("billing"), title: "Billing export" };

  it("links the thread named first in the text, whatever order they were picked in", () => {
    expect(linkedThreadForText("see #Billing export and #Fix login bug", [login, billing])).toBe(
      "billing",
    );
    expect(linkedThreadForText("see #Billing export and #Fix login bug", [billing, login])).toBe(
      "billing",
    );
  });

  it("drops a link whose token the user deleted", () => {
    expect(linkedThreadForText("see #Fix", [login])).toBeNull();
    expect(linkedThreadForText("never mind", [login, billing])).toBeNull();
  });
});
