import * as React from "react";

function legacyCopy(value: string): boolean {
  if (typeof document === "undefined") return false;
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  onCopy,
  onError,
}: {
  timeout?: number;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback((value: string, ctx: TContext): void => {
    if (typeof window === "undefined") {
      onErrorRef.current?.(new Error("Clipboard API unavailable."), ctx);
      return;
    }

    if (!value) return;

    const markCopied = () => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
      setIsCopied(true);
      onCopyRef.current?.(ctx);
      if (timeoutRef.current !== 0) {
        timeoutIdRef.current = setTimeout(() => {
          setIsCopied(false);
          timeoutIdRef.current = null;
        }, timeoutRef.current);
      }
    };

    const reportError = (error: Error) => {
      if (onErrorRef.current) {
        onErrorRef.current(error, ctx);
      } else {
        console.error(error);
      }
    };

    // `navigator.clipboard.writeText` is gated to secure contexts (HTTPS or
    // localhost). When the page is served over plain HTTP — e.g. dev access
    // via a Tailscale endpoint — fall back to the legacy `execCommand("copy")`
    // path which works in non-secure contexts.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(markCopied, (error: Error) => {
        if (legacyCopy(value)) {
          markCopied();
        } else {
          reportError(error);
        }
      });
      return;
    }

    if (legacyCopy(value)) {
      markCopied();
    } else {
      reportError(new Error("Clipboard API unavailable."));
    }
  }, []);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
