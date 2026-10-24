import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../timestampFormat";

/**
 * Header label and hover text for a side-thread message, matching the agent
 * timeline: time only today, the day once the message is older.
 */
export function sideThreadMessageTimestamp(
  message: { readonly createdAt: string; readonly editedAt?: string | undefined },
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
): { readonly label: string; readonly title: string } {
  const label = formatDayAwareTimestamp(message.createdAt, timestampFormat, nowMs);
  const title = formatChatTimestampTooltip(message.createdAt, timestampFormat);
  if (!message.editedAt) return { label, title };
  return {
    label: `${label} · edited`,
    title: `${title} (edited ${formatChatTimestampTooltip(message.editedAt, timestampFormat)})`,
  };
}
