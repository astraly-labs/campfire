import { QuoteIcon, XIcon } from "lucide-react";

import {
  markdownPreviewText,
  sideThreadExcerptText,
  type SideThreadDraftQuote,
} from "./sideThreadQuote";

/** The quote a team discussion draft will attach, shown above the composer until sent or removed. */
export function SideThreadPendingQuote(props: {
  readonly quote: SideThreadDraftQuote;
  readonly source: { readonly text: string } | undefined;
  readonly onRemove: () => void;
}) {
  const text = props.quote.excerpt
    ? sideThreadExcerptText(props.quote.excerpt.text)
    : markdownPreviewText(props.source?.text ?? "");
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
