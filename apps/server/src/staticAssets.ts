/**
 * Helpers for serving the built web app over slow links: content negotiation
 * for gzip, an in-memory cache of compressed variants, ETag revalidation and
 * cache-control policies.
 *
 * Remote teammates load the UI from this server over Tailscale, often on
 * high-latency / low-bandwidth connections. Serving the multi-megabyte
 * bundle uncompressed and uncached made every page load pay the full
 * transfer cost; with gzip + immutable caching a reload costs one small 304
 * round-trip for index.html and nothing for hashed assets.
 */
import { gzipSync } from "node:zlib";

/**
 * Only bother compressing payloads at least this large — below that the
 * gzip header overhead and the extra CPU outweigh the byte savings.
 */
export const STATIC_COMPRESSION_MIN_BYTES = 1_024;

/**
 * Total byte budget for cached compressed variants. The built web app's
 * compressible assets (JS/CSS/HTML/SVG/WASM) currently gzip to well under
 * this; the cap is a backstop so an unexpectedly large static dir cannot
 * balloon server memory. Insertion-order eviction is enough here: hashed
 * assets are immutable, so entries never need refreshing, and the working
 * set is "whatever the app shell loads", which fits comfortably.
 */
export const STATIC_GZIP_CACHE_MAX_TOTAL_BYTES = 48 * 1024 * 1024;

const COMPRESSIBLE_CONTENT_TYPE_PATTERN =
  /^(?:text\/|application\/(?:javascript|x-javascript|ecmascript|json|wasm|xml)(?:;|$)|application\/[^;]+\+(?:json|xml)(?:;|$)|image\/svg\+xml(?:;|$))/i;

export function isCompressibleContentType(contentType: string): boolean {
  return COMPRESSIBLE_CONTENT_TYPE_PATTERN.test(contentType.trim());
}

/**
 * Minimal Accept-Encoding parser: returns true when the client accepts gzip
 * (explicitly or via `*`) with a non-zero quality. We only ever emit gzip —
 * it is supported by every browser and works in both Bun and Node runtimes.
 */
export function clientAcceptsGzip(acceptEncodingHeader: string | undefined): boolean {
  if (!acceptEncodingHeader) {
    return false;
  }

  let wildcardAllowed: boolean | null = null;
  for (const rawPart of acceptEncodingHeader.split(",")) {
    const [rawCoding, ...rawParams] = rawPart.trim().split(";");
    const coding = rawCoding?.trim().toLowerCase();
    if (!coding) continue;
    if (coding !== "gzip" && coding !== "x-gzip" && coding !== "*") continue;

    let quality = 1;
    for (const rawParam of rawParams) {
      const [key, value] = rawParam.split("=").map((piece) => piece.trim().toLowerCase());
      if (key === "q" && value !== undefined) {
        const parsed = Number.parseFloat(value);
        if (!Number.isNaN(parsed)) {
          quality = parsed;
        }
      }
    }

    if (coding === "*") {
      wildcardAllowed = quality > 0;
    } else {
      // Explicit gzip entry wins over a wildcard either way.
      return quality > 0;
    }
  }

  return wildcardAllowed ?? false;
}

/**
 * Hashed build outputs live under `assets/` and can be cached forever;
 * everything else (index.html, favicons, manifest) must revalidate so a
 * deploy is picked up on the next load. `no-cache` still allows storing —
 * paired with an ETag it turns a reload into a 304 instead of a re-download.
 */
export function resolveStaticCacheControl(staticRelativePath: string): string {
  const normalized = staticRelativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.startsWith("assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

export function makeStaticEtag(sizeBytes: number | bigint, mtimeMs: number): string {
  return `W/"${sizeBytes.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
}

function stripEtagDecorations(rawEtag: string): string {
  return rawEtag.trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
}

export function etagMatches(ifNoneMatchHeader: string | undefined, etag: string): boolean {
  if (!ifNoneMatchHeader) {
    return false;
  }
  if (ifNoneMatchHeader.trim() === "*") {
    return true;
  }
  const target = stripEtagDecorations(etag);
  return ifNoneMatchHeader
    .split(",")
    .some((candidate) => stripEtagDecorations(candidate) === target);
}

interface GzipCacheState {
  readonly entries: Map<string, Uint8Array>;
  totalBytes: number;
}

const gzipCache: GzipCacheState = {
  entries: new Map(),
  totalBytes: 0,
};

/**
 * Return the gzipped bytes for `raw`, caching by `cacheKey`. Callers must
 * derive the key from the file identity (path + size + mtime) so a changed
 * file naturally misses the stale entry.
 */
export function getOrCompressGzip(cacheKey: string, raw: Uint8Array): Uint8Array {
  const cached = gzipCache.entries.get(cacheKey);
  if (cached) {
    return cached;
  }

  const compressed = new Uint8Array(gzipSync(raw, { level: 6 }));
  if (compressed.byteLength <= STATIC_GZIP_CACHE_MAX_TOTAL_BYTES) {
    gzipCache.entries.set(cacheKey, compressed);
    gzipCache.totalBytes += compressed.byteLength;
    for (const [oldestKey, oldestBytes] of gzipCache.entries) {
      if (gzipCache.totalBytes <= STATIC_GZIP_CACHE_MAX_TOTAL_BYTES) {
        break;
      }
      if (oldestKey === cacheKey) {
        // Never evict the entry we just inserted on its own insert pass.
        continue;
      }
      gzipCache.entries.delete(oldestKey);
      gzipCache.totalBytes -= oldestBytes.byteLength;
    }
  }
  return compressed;
}

export function resetStaticGzipCacheForTests(): void {
  gzipCache.entries.clear();
  gzipCache.totalBytes = 0;
}

export function getStaticGzipCacheStatsForTests(): { entryCount: number; totalBytes: number } {
  return { entryCount: gzipCache.entries.size, totalBytes: gzipCache.totalBytes };
}
