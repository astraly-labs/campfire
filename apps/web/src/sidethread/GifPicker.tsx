import { SearchIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { isGiphyConfigured, searchGifs, trendingGifs, type GiphyGif } from "./giphyClient";

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onPick: (gif: GiphyGif) => void;
}

const DEBOUNCE_MS = 280;

/**
 * Telegram-style GIF picker. Anchored as an absolutely-positioned panel
 * inside the side-thread drawer rather than a modal — staying inside the
 * drawer keeps the picker close to the composer (Telegram does the same
 * thing) and avoids stealing focus from messages users may still want
 * to skim while choosing a GIF.
 *
 * Search is debounced; empty query falls back to Tenor's `/featured`
 * (the "trending now" rail). Each result is rendered as the static
 * preview to keep the grid lightweight — we only start the MP4 stream
 * once the user has actually chosen the GIF.
 */
export function GifPicker({ open, onClose, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GiphyGif[]>([]);
  const [loading, setLoading] = useState(false);
  const configured = useMemo(() => isGiphyConfigured(), []);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // Autofocus the search box when the picker opens — Telegram does
    // this and it removes a click for users who know what they want.
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !configured) return;
    let cancelled = false;
    setLoading(true);
    const handle = window.setTimeout(async () => {
      const next = query.trim().length === 0 ? await trendingGifs(24) : await searchGifs(query.trim(), 24);
      if (!cancelled) {
        setResults(next);
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, query, configured]);

  if (!open) return null;

  return (
    <div
      className="absolute inset-x-3 bottom-[calc(100%-0.25rem)] z-20 flex max-h-[60vh] flex-col overflow-hidden rounded-lg border border-border/70 bg-popover shadow-xl"
      role="dialog"
      aria-label="Pick a GIF"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <SearchIcon className="size-3.5 text-muted-foreground/60" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search GIPHY…"
          className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close GIF picker"
          className="text-muted-foreground/60 hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {!configured ? (
          <p className="px-2 py-3 text-xs text-muted-foreground/70">
            Set <code className="rounded bg-muted px-1 text-[10px]">VITE_GIPHY_API_KEY</code> to
            enable the GIF picker. Get a free key from{" "}
            <span className="text-muted-foreground/90">developers.giphy.com</span>.
          </p>
        ) : loading && results.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground/60">Loading…</p>
        ) : results.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground/60">
            No GIFs found for &ldquo;{query}&rdquo;.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {results.map((gif) => (
              <button
                key={gif.id}
                type="button"
                onClick={() => onPick(gif)}
                title={gif.title}
                className={cn(
                  "group/gif relative overflow-hidden rounded-md bg-muted/40 ring-1 ring-border/40 transition-all hover:ring-2 hover:ring-amber-500/40",
                )}
                style={{ aspectRatio: `${gif.width} / ${gif.height}` }}
              >
                <img
                  src={gif.previewUrl}
                  alt={gif.title || "GIF"}
                  loading="lazy"
                  className="size-full object-cover transition-transform group-hover/gif:scale-105"
                />
              </button>
            ))}
          </div>
        )}
      </div>
      {configured ? (
        <div className="border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground/50">
          Powered by GIPHY
        </div>
      ) : null}
    </div>
  );
}
