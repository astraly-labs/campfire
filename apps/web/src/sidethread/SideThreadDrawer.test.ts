import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sideThreadIdForMessage } from "./SideThreadDrawer";

describe("SideThreadDrawer", () => {
  it("derives one stable discussion id per anchor message", () => {
    const first = sideThreadIdForMessage(MessageId.make("message-1"));
    expect(first).toBe("message:message-1");
    expect(sideThreadIdForMessage(MessageId.make("message-1"))).toBe(first);
    expect(sideThreadIdForMessage(MessageId.make("message-2"))).not.toBe(first);
  });
});
