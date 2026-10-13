import type { SideThreadGifAttachment } from "@t3tools/contracts";

const GIPHY_BASE_URL = "https://api.giphy.com/v1/gifs";

export interface GiphyGif {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly previewUrl: string;
  readonly width: number;
  readonly height: number;
}

interface GiphyVariant {
  readonly url?: string;
  readonly mp4?: string;
  readonly width?: string;
  readonly height?: string;
}

interface GiphyResult {
  readonly id?: string;
  readonly title?: string;
  readonly images?: {
    readonly fixed_width?: GiphyVariant;
    readonly fixed_width_still?: GiphyVariant;
    readonly original?: GiphyVariant;
    readonly original_still?: GiphyVariant;
  };
}

function apiKey(): string | null {
  const value = (import.meta.env as { VITE_GIPHY_API_KEY?: string }).VITE_GIPHY_API_KEY?.trim();
  return value || null;
}

export function isGiphyConfigured(): boolean {
  return apiKey() !== null;
}

function positiveDimension(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
}

function mapResult(result: GiphyResult): GiphyGif | null {
  const playback = result.images?.fixed_width ?? result.images?.original;
  const url = playback?.mp4 ?? playback?.url;
  const previewUrl =
    result.images?.fixed_width_still?.url ?? result.images?.original_still?.url ?? playback?.url;
  if (!result.id || !url || !previewUrl) return null;
  return {
    id: result.id,
    title: result.title ?? "",
    url,
    previewUrl,
    width: positiveDimension(playback?.width),
    height: positiveDimension(playback?.height),
  };
}

async function request(path: string, query: Record<string, string>): Promise<GiphyGif[]> {
  const key = apiKey();
  if (!key) return [];
  const params = new URLSearchParams({
    api_key: key,
    rating: "g",
    bundle: "messaging_non_clips",
    limit: "24",
    ...query,
  });
  try {
    const response = await fetch(`${GIPHY_BASE_URL}/${path}?${params}`);
    if (!response.ok) return [];
    const payload = (await response.json()) as { readonly data?: ReadonlyArray<GiphyResult> };
    return (payload.data ?? []).flatMap((result) => {
      const mapped = mapResult(result);
      return mapped ? [mapped] : [];
    });
  } catch {
    return [];
  }
}

export function searchGifs(query: string): Promise<GiphyGif[]> {
  return request("search", { q: query, offset: "0", lang: "en" });
}

export function trendingGifs(): Promise<GiphyGif[]> {
  return request("trending", {});
}

export function giphyAttachment(gif: GiphyGif): SideThreadGifAttachment {
  return {
    type: "gif",
    url: gif.url,
    previewUrl: gif.previewUrl,
    width: gif.width,
    height: gif.height,
    providerId: gif.id,
  };
}
