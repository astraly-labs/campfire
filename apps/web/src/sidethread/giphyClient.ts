import type { SideThreadGifAttachment } from "@t3tools/contracts";

/**
 * Thin browser-side wrapper around Giphy's v1 REST API. We hit Giphy
 * directly from the renderer to keep the integration self-contained;
 * the `VITE_GIPHY_API_KEY` is a read-only client key per Giphy's
 * docs (a "Web SDK" key), not a server-side secret.
 *
 * If the key isn't configured we gracefully degrade: search/trending
 * resolve to an empty list and the picker surfaces a hint to the user.
 *
 * Giphy docs: https://developers.giphy.com/docs/api/endpoint/
 */

const GIPHY_BASE = "https://api.giphy.com/v1/gifs";

export interface GiphyGif {
  readonly id: string;
  readonly title: string;
  readonly mp4Url: string;
  readonly previewUrl: string;
  readonly width: number;
  readonly height: number;
}

interface GiphyImageVariant {
  readonly url?: string;
  readonly mp4?: string;
  readonly width?: string;
  readonly height?: string;
  readonly mp4_size?: string;
}

interface GiphyResult {
  readonly id?: string;
  readonly title?: string;
  readonly images?: {
    /** ~200px wide MP4 — sweet spot for Telegram-style chat embeds. */
    readonly fixed_width?: GiphyImageVariant;
    readonly fixed_width_small?: GiphyImageVariant;
    /** Static thumb used while the MP4 preloads inside the picker grid. */
    readonly fixed_width_still?: GiphyImageVariant;
    readonly fixed_width_small_still?: GiphyImageVariant;
    readonly original?: GiphyImageVariant;
    readonly original_still?: GiphyImageVariant;
  };
}

interface GiphyResponse {
  readonly data?: ReadonlyArray<GiphyResult>;
}

/**
 * Resolve the configured Giphy API key. Returning `null` here (rather
 * than throwing) lets the picker render an empty-state message instead
 * of crashing the whole drawer on a misconfigured deployment.
 */
function getApiKey(): string | null {
  const fromEnv = (import.meta.env as { VITE_GIPHY_API_KEY?: string }).VITE_GIPHY_API_KEY;
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

export const isGiphyConfigured = (): boolean => getApiKey() !== null;

function pickDims(variant: GiphyImageVariant | undefined, fallback: [number, number]): [number, number] {
  const w = variant?.width ? Number.parseInt(variant.width, 10) : Number.NaN;
  const h = variant?.height ? Number.parseInt(variant.height, 10) : Number.NaN;
  return [
    Number.isFinite(w) && w > 0 ? w : fallback[0],
    Number.isFinite(h) && h > 0 ? h : fallback[1],
  ];
}

function mapResult(r: GiphyResult): GiphyGif | null {
  const id = r.id;
  // Prefer `fixed_width` (~200px MP4) — fast to load, autoplays in
  // every modern browser, and matches the size we render inline.
  const playback = r.images?.fixed_width ?? r.images?.original;
  const mp4 = playback?.mp4;
  const preview =
    r.images?.fixed_width_still?.url ??
    r.images?.fixed_width_small_still?.url ??
    r.images?.original_still?.url ??
    playback?.url;
  if (!id || !mp4 || !preview) return null;
  const [w, h] = pickDims(playback, [200, 200]);
  return {
    id,
    title: r.title ?? "",
    mp4Url: mp4,
    previewUrl: preview,
    width: w,
    height: h,
  };
}

async function fetchGiphy(path: string, params: Record<string, string>): Promise<GiphyGif[]> {
  const key = getApiKey();
  if (!key) return [];
  const query = new URLSearchParams({
    api_key: key,
    // `g` = General audience — keeps the picker safe-for-work by default.
    // Matches the rating Slack/Teams use for their Giphy integrations.
    rating: "g",
    bundle: "messaging_non_clips",
    ...params,
  });
  try {
    const response = await fetch(`${GIPHY_BASE}${path}?${query.toString()}`);
    if (!response.ok) return [];
    const data = (await response.json()) as GiphyResponse;
    return (data.data ?? []).map(mapResult).filter((g): g is GiphyGif => g !== null);
  } catch {
    return [];
  }
}

export const searchGifs = (query: string, limit = 24): Promise<GiphyGif[]> =>
  fetchGiphy("/search", { q: query, limit: String(limit), offset: "0", lang: "en" });

export const trendingGifs = (limit = 24): Promise<GiphyGif[]> =>
  fetchGiphy("/trending", { limit: String(limit) });

/**
 * Adapt a Giphy result into the wire-shape consumed by the side-thread
 * message-post command. `mapResult` already trims/clamps the inputs we
 * care about, so this is a straight cast — the server re-decodes the
 * payload through the contract schema, which will reject anything that
 * slipped through.
 */
export function toAttachment(gif: GiphyGif): SideThreadGifAttachment | null {
  if (!gif.mp4Url || !gif.previewUrl || gif.width < 1 || gif.height < 1) return null;
  return {
    kind: "gif",
    url: gif.mp4Url as SideThreadGifAttachment["url"],
    previewUrl: gif.previewUrl as SideThreadGifAttachment["previewUrl"],
    width: gif.width as SideThreadGifAttachment["width"],
    height: gif.height as SideThreadGifAttachment["height"],
    providerId: gif.id as SideThreadGifAttachment["providerId"],
  };
}
