import type { SideThreadQuotedExcerpt } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import { QuoteIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { sideThreadQuoteText, type SideThreadDraftQuote } from "./sideThreadQuote";
import { sideThreadMessageTimestamp } from "./sideThreadTimestamp";

interface QuoteSource {
  readonly text: string;
  readonly createdAt: DateTime.Utc;
}

/** The quote a team discussion draft will attach, shown above the composer until sent or removed. */
export function SideThreadPendingQuote(props: {
  readonly quote: SideThreadDraftQuote;
  readonly source: QuoteSource | undefined;
  readonly onRemove: () => void;
}) {
  const text = sideThreadQuoteText(props.quote.excerpt, props.source?.text);
  return (
    <div className="flex items-start gap-2 rounded-lg bg-muted px-2 py-1 text-xs text-muted-foreground">
      <QuoteIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
      <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-line">
        {text || "Agent message"}
      </span>
      <button
        type="button"
        aria-label="Remove quote"
        className="mt-0.5 shrink-0 hover:text-foreground"
        onClick={props.onRemove}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

/** A sent message's quote. Clicking it shows the source in the agent thread. */
export function SideThreadQuoteCard(props: {
  readonly excerpt: SideThreadQuotedExcerpt | undefined;
  readonly source: QuoteSource | undefined;
  readonly timestampFormat: TimestampFormat;
  readonly onReveal: () => void;
}) {
  const { excerpt, source } = props;
  const textRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const expandable = excerpt !== undefined;
  useEffect(() => {
    const element = textRef.current;
    if (!element || !expandable) return;
    return observeResize(element, () => setClamped(element.scrollHeight > element.clientHeight));
  }, [expandable]);
  const createdAt = source ? DateTime.formatIso(source.createdAt) : null;
  return (
    <div className="mb-2 rounded-md border-l-2 border-info/60 bg-background/55 text-2xs text-muted-foreground">
      <button
        type="button"
        className="block w-full px-2 py-1 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={props.onReveal}
      >
        <span className="block font-medium">
          Agent thread
          {createdAt ? (
            <>
              {" · "}
              <time dateTime={createdAt}>
                {sideThreadMessageTimestamp({ createdAt }, props.timestampFormat).label}
              </time>
            </>
          ) : null}
        </span>
        <span
          ref={textRef}
          className={cn(
            "whitespace-pre-line",
            !expandable ? "line-clamp-2" : expanded ? "block" : "line-clamp-3",
          )}
        >
          {sideThreadQuoteText(excerpt, source?.text)}
        </span>
      </button>
      {expandable && (clamped || expanded) ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="px-2 pb-1 hover:text-foreground"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
