import { SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isGiphyConfigured, searchGifs, trendingGifs, type GiphyGif } from "./giphyClient";

export function GifPicker(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onPick: (gif: GiphyGif) => void;
}) {
  const { open, onClose, onPick } = props;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<GiphyGif>>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !isGiphyConfigured()) return;
    let cancelled = false;
    setLoading(true);
    const timeout = window.setTimeout(() => {
      const request = query.trim() ? searchGifs(query.trim()) : trendingGifs();
      void request.then((next) => {
        if (cancelled) return;
        setResults(next);
        setLoading(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [open, query]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label="Pick a GIF"
      className="absolute bottom-full left-0 z-30 mb-2 flex max-h-[55vh] w-80 flex-col overflow-hidden rounded-xl border bg-popover shadow-xl"
    >
      <div className="flex items-center gap-2 border-b px-2 py-2">
        <SearchIcon className="size-3.5 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search GIPHY…"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        <button type="button" onClick={onClose} aria-label="Close GIF picker">
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="min-h-24 flex-1 overflow-y-auto p-2">
        {!isGiphyConfigured() ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Add VITE_GIPHY_API_KEY to enable search. You can still paste a direct GIF URL below.
          </p>
        ) : loading && results.length === 0 ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : results.length === 0 ? (
          <p className="text-xs text-muted-foreground">No GIFs found.</p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {results.map((gif) => (
              <button
                key={gif.id}
                type="button"
                title={gif.title}
                onClick={() => onPick(gif)}
                className="overflow-hidden rounded-md bg-muted ring-1 ring-border hover:ring-primary"
                style={{ aspectRatio: `${gif.width} / ${gif.height}` }}
              >
                <img
                  src={gif.previewUrl}
                  alt={gif.title || "GIF"}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="size-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </div>
      {isGiphyConfigured() ? (
        <div className="border-t px-2 py-1 text-[10px] text-muted-foreground">Powered by GIPHY</div>
      ) : null}
    </div>
  );
}
