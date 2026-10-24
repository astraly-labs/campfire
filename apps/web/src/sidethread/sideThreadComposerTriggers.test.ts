import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  detectSideThreadTrigger,
  linkedThreadForText,
  matchMentionItems,
  matchThreadLinkItems,
  mentionedTeammates,
  suggestionToken,
  type ThreadLinkCandidate,
} from "./sideThreadComposerTriggers";

const team = [
  { subject: "google:me", displayName: "Me Myself" },
  { subject: "google:jane", displayName: "Jane Doe" },
  { subject: "google:janet", displayName: "Jane Doering" },
  { subject: "google:bob", displayName: "Bob Stone" },
  { subject: "google:zoe", displayName: "Zoë Ångström" },
];

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

describe("matchMentionItems", () => {
  it("offers every teammate but the current user", () => {
    expect(
      matchMentionItems({ team, currentSubject: "google:me", query: "" }).map((item) => item.label),
    ).toEqual(["Jane Doe", "Jane Doering", "Bob Stone", "Zoë Ångström"]);
  });

  it("filters by handle or display name, ignoring case", () => {
    const labels = (query: string) =>
      matchMentionItems({ team, currentSubject: null, query }).map((item) => item.label);
    expect(labels("jane.doer")).toEqual(["Jane Doering"]);
    expect(labels("STONE")).toEqual(["Bob Stone"]);
    // The handle is zoe.angstrom; the accented name only matches the display name.
    expect(labels("zoë")).toEqual(["Zoë Ångström"]);
  });

  it("inserts the handle that send-time mention parsing recognizes", () => {
    const [jane] = matchMentionItems({ team, currentSubject: null, query: "jane" });
    const token = jane ? suggestionToken(jane) : "";
    expect(token).toBe("@jane.doe ");
    expect(mentionedTeammates(`hey ${token}look`, team)).toEqual([
      { subject: "google:jane", displayName: "Jane Doe" },
    ]);
  });
});

describe("mentionedTeammates", () => {
  it("notifies exact handles only, not teammates whose handle is a prefix", () => {
    expect(
      mentionedTeammates("@jane.doering can you check?", team).map((user) => user.subject),
    ).toEqual(["google:janet"]);
  });

  it("accepts a handle at the end of a sentence and ignores case", () => {
    expect(mentionedTeammates("Thanks @Bob.Stone.", team).map((user) => user.subject)).toEqual([
      "google:bob",
    ]);
  });

  it("ignores email addresses and unknown handles", () => {
    expect(mentionedTeammates("mail bob@stone.dev or @nobody", team)).toEqual([]);
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
