/**
 * AvatarStack — stack of small initial chips for a list of viewers.
 *
 * Sized for the three surfaces it's dropped into (sidebar row, chat header,
 * side-thread anchor). When more than `maxVisible` viewers are present, a
 * trailing "+N" chip absorbs the overflow. Tooltips reveal the displayName
 * (+ "typing…" when relevant) so the chips themselves stay terse.
 *
 * Colors are deterministic per `userId` so the same human gets the same hue
 * across surfaces and sessions — recognisability beats variety here.
 */
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "~/lib/utils";

import type { ViewerInfo } from "./presenceStore";

export interface AvatarStackProps {
  readonly viewers: ReadonlyArray<ViewerInfo>;
  readonly maxVisible?: number;
  /** Smaller chips for tight rows (sidebar, anchor button). */
  readonly size?: "sm" | "md";
  /** Tweak overlap and z-stacking when nested inside a busy row. */
  readonly className?: string;
}

export const SOFT_PALETTE: ReadonlyArray<{ bg: string; text: string }> = [
  { bg: "bg-amber-200", text: "text-amber-900" },
  { bg: "bg-emerald-200", text: "text-emerald-900" },
  { bg: "bg-sky-200", text: "text-sky-900" },
  { bg: "bg-violet-200", text: "text-violet-900" },
  { bg: "bg-rose-200", text: "text-rose-900" },
  { bg: "bg-orange-200", text: "text-orange-900" },
];

// Author-name text colors, aligned 1:1 with SOFT_PALETTE so an avatar chip
// and a displayName for the same user share the same hue. Tuned for chat
// labels — vivid enough to scan, not so loud it competes with the message.
export const NAME_TEXT_PALETTE: ReadonlyArray<string> = [
  "text-amber-600 dark:text-amber-300",
  "text-emerald-600 dark:text-emerald-300",
  "text-sky-600 dark:text-sky-300",
  "text-violet-600 dark:text-violet-300",
  "text-rose-600 dark:text-rose-300",
  "text-orange-600 dark:text-orange-300",
];

/**
 * Exported for tests — a small FNV-1a-style hash on the user id mapped into
 * the palette index. Deterministic across reloads, which is the whole point
 * of giving users a stable color.
 */
export function colorIndexForUserId(userId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % SOFT_PALETTE.length;
}

/**
 * Two initials, drawn from word boundaries. "Matthias" → "M",
 * "Matteo Combe" → "MC". Pure for tests.
 */
export function initialsFor(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

export function AvatarStack({ viewers, maxVisible = 3, size = "sm", className }: AvatarStackProps) {
  if (viewers.length === 0) return null;

  const visible = viewers.slice(0, maxVisible);
  const overflow = viewers.length - visible.length;

  const sizeClasses =
    size === "sm"
      ? "size-4 text-[8px] -ml-1 first:ml-0 ring-1"
      : "size-5 text-[9px] -ml-1.5 first:ml-0 ring-2";

  return (
    <div className={cn("flex shrink-0 items-center", className)} aria-label="Viewers">
      {visible.map((viewer) => {
        const idx = colorIndexForUserId(viewer.user.id);
        const palette = SOFT_PALETTE[idx]!;
        return (
          <Tooltip key={viewer.user.id}>
            <TooltipTrigger
              render={(props) => (
                <span
                  {...props}
                  className={cn(
                    "inline-flex items-center justify-center rounded-full font-medium ring-background",
                    palette.bg,
                    palette.text,
                    sizeClasses,
                    viewer.isTyping && "ring-amber-400 animate-pulse motion-reduce:animate-none",
                  )}
                >
                  {initialsFor(viewer.user.displayName)}
                </span>
              )}
            />
            <TooltipPopup side="top">
              {viewer.user.displayName}
              {viewer.isTyping ? " — typing…" : ""}
            </TooltipPopup>
          </Tooltip>
        );
      })}
      {overflow > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={(props) => (
              <span
                {...props}
                className={cn(
                  "inline-flex items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ring-background",
                  sizeClasses,
                )}
              >
                +{overflow}
              </span>
            )}
          />
          <TooltipPopup side="top">
            {viewers
              .slice(maxVisible)
              .map((v) => v.user.displayName)
              .join(", ")}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
