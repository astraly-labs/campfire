import { describe, expect, it } from "vitest";

import type { TeamInboxItem } from "../inbox/teamInbox";
import { newUnreadTeamInboxItems } from "./teamInboxNotifications";

function item(id: string, unread: boolean): TeamInboxItem {
  return {
    thread: { environmentId: "env", id } as TeamInboxItem["thread"],
    discussion: {} as TeamInboxItem["discussion"],
    preview: { id: `message-${id}` } as TeamInboxItem["preview"],
    isMention: false,
    unread,
  };
}

describe("newUnreadTeamInboxItems", () => {
  it("only returns newly observed unread messages", () => {
    expect(
      newUnreadTeamInboxItems(new Set(["env:known:message-known"]), [
        item("known", true),
        item("new", true),
        item("read", false),
      ]).map((entry) => entry.thread.id),
    ).toEqual(["new"]);
  });
});
