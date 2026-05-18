import { type ReactNode, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

const ANIMATION_MS = 200;

interface InlineSlideDrawerProps {
  open: boolean;
  width: number;
  children: ReactNode;
  className?: string;
}

/**
 * Inline drawer wrapper that animates open/close with a slide-from-right +
 * fade, mirroring the Base UI `Sheet` animation (200ms ease-in-out). The outer
 * shell animates `width` so the surrounding flex layout doesn't snap when the
 * drawer mounts/unmounts; the inner panel keeps its full width and slides in.
 *
 * Keeps the last rendered children mounted during the close animation so the
 * panel doesn't flash empty before sliding out.
 */
export function InlineSlideDrawer({ open, width, children, className }: InlineSlideDrawerProps) {
  const [mounted, setMounted] = useState(open);
  const [active, setActive] = useState(open);
  const lastChildrenRef = useRef<ReactNode>(children);

  if (open) {
    lastChildrenRef.current = children;
  }

  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setActive(true));
      return () => cancelAnimationFrame(frame);
    }
    setActive(false);
    const timer = window.setTimeout(() => setMounted(false), ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      className={cn(
        "h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out",
        className,
      )}
      style={{ width: active ? width : 0 }}
    >
      <div
        className={cn(
          "h-full transition-[opacity,translate] duration-200 ease-in-out will-change-transform",
          active ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0",
        )}
        style={{ width }}
      >
        {open ? children : lastChildrenRef.current}
      </div>
    </div>
  );
}
