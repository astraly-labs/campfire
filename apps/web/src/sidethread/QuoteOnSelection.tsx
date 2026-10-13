import { QuoteIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function formatSideThreadQuote(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
  if (!normalized) return "";
  return `${normalized
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")}\n\n`;
}

export function QuoteOnSelection(props: {
  readonly children: ReactNode;
  readonly onQuote: (text: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<{
    readonly text: string;
    readonly top: number;
    readonly left: number;
  } | null>(null);

  const updateSelection = useCallback(() => {
    const root = rootRef.current;
    const current = window.getSelection();
    if (!root || !current || current.isCollapsed || current.rangeCount === 0) {
      setSelection(null);
      return;
    }
    if (!current.anchorNode || !current.focusNode) return;
    if (!root.contains(current.anchorNode) || !root.contains(current.focusNode)) return;
    const text = current.toString().trim();
    if (!text) return;
    const rect = current.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    setSelection({
      text,
      top: Math.max(8, rect.top - 8),
      left: Math.max(8, Math.min(window.innerWidth - 150, rect.left + rect.width / 2 - 75)),
    });
  }, []);

  useEffect(() => {
    const onMouseUp = () => requestAnimationFrame(updateSelection);
    const clear = () => setSelection(null);
    const onSelectionChange = () => {
      if (window.getSelection()?.isCollapsed) clear();
    };
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
    };
  }, [updateSelection]);

  return (
    <>
      <div ref={rootRef}>{props.children}</div>
      {selection
        ? createPortal(
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                props.onQuote(formatSideThreadQuote(selection.text));
                window.getSelection()?.removeAllRanges();
                setSelection(null);
              }}
              style={{
                position: "fixed",
                top: selection.top,
                left: selection.left,
                transform: "translateY(-100%)",
                zIndex: 60,
              }}
              className="inline-flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1 text-[11px] font-medium shadow-lg hover:bg-accent"
            >
              <QuoteIcon className="size-3" /> Quote in discussion
            </button>,
            document.body,
          )
        : null}
    </>
  );
}
