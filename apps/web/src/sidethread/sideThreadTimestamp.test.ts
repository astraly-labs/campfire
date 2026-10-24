import { describe, expect, it } from "vite-plus/test";

import { formatShortTimestamp } from "../timestampFormat";
import { sideThreadMessageTimestamp } from "./sideThreadTimestamp";

// Local-time constructors keep calendar-day boundaries stable in any test timezone.
const iso = (y: number, monthIndex: number, d: number, h: number, mi: number) =>
  new Date(y, monthIndex, d, h, mi).toISOString();
const now = new Date(2026, 9, 24, 16, 0).getTime();

describe("sideThreadMessageTimestamp", () => {
  it("shows only the time for a message sent today", () => {
    const createdAt = iso(2026, 9, 24, 14, 12);
    expect(sideThreadMessageTimestamp({ createdAt }, "24-hour", now).label).toBe(
      formatShortTimestamp(createdAt, "24-hour"),
    );
  });

  it("names yesterday for a message from the previous calendar day", () => {
    const createdAt = iso(2026, 9, 23, 14, 12);
    expect(sideThreadMessageTimestamp({ createdAt }, "24-hour", now).label).toBe(
      `yesterday at ${formatShortTimestamp(createdAt, "24-hour")}`,
    );
  });

  it("includes the date for an older message", () => {
    const createdAt = iso(2026, 9, 2, 14, 12);
    const day = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" }).format(
      new Date(createdAt),
    );
    expect(sideThreadMessageTimestamp({ createdAt }, "24-hour", now).label).toBe(
      `${day} ${formatShortTimestamp(createdAt, "24-hour")}`,
    );
  });

  it("gives the full date in the hover text, even for today", () => {
    const createdAt = iso(2026, 9, 24, 14, 12);
    expect(sideThreadMessageTimestamp({ createdAt }, "24-hour", now).title).toContain(
      "24th October 2026",
    );
  });

  it("marks edited messages in both the label and the hover text", () => {
    const createdAt = iso(2026, 9, 24, 14, 12);
    const editedAt = iso(2026, 9, 24, 15, 1);
    const stamp = sideThreadMessageTimestamp({ createdAt, editedAt }, "24-hour", now);
    expect(stamp.label).toBe(`${formatShortTimestamp(createdAt, "24-hour")} · edited`);
    expect(stamp.title).toContain(`edited ${formatShortTimestamp(editedAt, "24-hour")}`);
  });
});
