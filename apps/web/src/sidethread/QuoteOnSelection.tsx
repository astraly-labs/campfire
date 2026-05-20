import type { MessageId, ThreadId } from "@t3tools/contracts";
import { QuoteIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";
import { useSideThreadStore } from "./sideThreadStore";

interface Props {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly children: ReactNode;
  readonly className?: string;
}

interface PopoverState {
  readonly text: string;
  readonly top: number;
  readonly left: number;
  readonly placement: "above" | "below";
}

const POPOVER_VERTICAL_GAP = 8;
const POPOVER_ABOVE_MIN_TOP = 12;

/**
 * Wraps a block of selectable content (typically an assistant message body)
 * and surfaces a floating "Cite in side thread" affordance when the user
 * highlights text inside it. The selection is normalized to a markdown
 * blockquote and dropped into the side-thread composer via the store's
 * one-shot `draftPrefill`. The popover never affects the underlying DOM —
 * it lives in a portal so transformed/overflow-clipped ancestors can't
 * trap it.
 */
export function QuoteOnSelection({ threadId, messageId, children, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLButtonElement>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const open = useSideThreadStore((state) => state.open);

  const recompute = useCallback(() => {
    const root = containerRef.current;
    if (!root) {
      setPopover(null);
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setPopover(null);
      return;
    }
    const text = selection.toString();
    if (text.trim().length === 0) {
      setPopover(null);
      return;
    }
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode) {
      setPopover(null);
      return;
    }
    // Both ends must live inside this instance — otherwise we'd render a
    // popover for a selection that started in another message.
    if (!root.contains(anchorNode) || !root.contains(focusNode)) {
      setPopover(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setPopover(null);
      return;
    }
    // Center horizontally on the selection, clamp to viewport so the
    // popover never spills off-screen on narrow widths.
    const approxWidth = 180;
    const horizontalMargin = 8;
    const idealLeft = rect.left + rect.width / 2 - approxWidth / 2;
    const maxLeft = window.innerWidth - approxWidth - horizontalMargin;
    const left = Math.max(horizontalMargin, Math.min(idealLeft, maxLeft));

    const aboveTop = rect.top - POPOVER_VERTICAL_GAP;
    const fitsAbove = aboveTop > POPOVER_ABOVE_MIN_TOP;
    const top = fitsAbove ? aboveTop : rect.bottom + POPOVER_VERTICAL_GAP;
    const placement: "above" | "below" = fitsAbove ? "above" : "below";

    setPopover({ text, top, left, placement });
  }, []);

  useEffect(() => {
    // `mouseup` is the only event that reliably means "the user finished a
    // selection gesture" — listening to `selectionchange` here would make
    // the popover jitter during the drag.
    const onMouseUp = () => {
      // Defer one frame so the selection has been finalized by the time we
      // read `window.getSelection()` (mouseup → selection update order is
      // browser-dependent on some inputs).
      requestAnimationFrame(recompute);
    };
    // But we DO want `selectionchange` for the inverse direction — if the
    // user clicks elsewhere and collapses the selection, hide the popover
    // even without a mouseup over our subtree (e.g. caret moved via keyboard
    // or click on another element).
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setPopover(null);
      }
    };
    const onScroll = () => setPopover(null);

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    // Hide on scroll/resize rather than recomputing — repositioning while
    // scrolling tends to feel laggy, and a stale popover is worse than a
    // missing one.
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);

    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [recompute]);

  const handleCite = useCallback(() => {
    if (!popover) return;
    const blockquote = formatAsBlockquote(popover.text);
    open(threadId, { draftPrefill: blockquote, quotedMessageId: messageId });
    setPopover(null);
    // Clear the visible selection so the popover doesn't immediately
    // re-appear on the next `mouseup` over the same range.
    window.getSelection()?.removeAllRanges();
  }, [popover, open, threadId, messageId]);

  return (
    <>
      <div ref={containerRef} className={className}>
        {children}
      </div>
      {popover
        ? createPortal(
            <button
              ref={popoverRef}
              type="button"
              // Prevent the mousedown from collapsing the selection before
              // our click handler fires — without this the toString() would
              // come back empty on slower machines.
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleCite}
              style={{
                position: "fixed",
                top: popover.top,
                left: popover.left,
                transform: popover.placement === "above" ? "translateY(-100%)" : undefined,
                zIndex: 50,
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-popover px-2 py-1 text-[11px] font-medium text-foreground shadow-lg",
                "hover:bg-accent hover:text-accent-foreground",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <QuoteIcon className="size-3" aria-hidden />
              Citer dans le side thread
            </button>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * Turn arbitrary selected text into a markdown blockquote. Each line is
 * prefixed with `> `; an empty trailing line is appended so the user's
 * cursor lands on a fresh paragraph below the citation. We do NOT try to
 * recover markdown source for the selection — the rendered DOM doesn't
 * know about formatting marks, and plaintext is what readers expect from a
 * quoted passage anyway.
 */
function formatAsBlockquote(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
  if (normalized.length === 0) return "";
  const quoted = normalized
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
  return `${quoted}\n\n`;
}
