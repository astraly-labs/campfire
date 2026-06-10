import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clientAcceptsGzip,
  etagMatches,
  getOrCompressGzip,
  getStaticGzipCacheStatsForTests,
  isCompressibleContentType,
  makeStaticEtag,
  resetStaticGzipCacheForTests,
  resolveStaticCacheControl,
  STATIC_GZIP_CACHE_MAX_TOTAL_BYTES,
} from "./staticAssets.ts";

describe("staticAssets", () => {
  beforeEach(() => {
    resetStaticGzipCacheForTests();
  });

  describe("isCompressibleContentType", () => {
    it.each([
      "text/html; charset=utf-8",
      "text/css",
      "application/javascript",
      "application/json",
      "application/manifest+json",
      "application/wasm",
      "image/svg+xml",
    ])("accepts %s", (contentType) => {
      expect(isCompressibleContentType(contentType)).toBe(true);
    });

    it.each(["image/png", "font/woff2", "application/octet-stream", "video/mp4"])(
      "rejects %s",
      (contentType) => {
        expect(isCompressibleContentType(contentType)).toBe(false);
      },
    );
  });

  describe("clientAcceptsGzip", () => {
    it("accepts the common browser header", () => {
      expect(clientAcceptsGzip("gzip, deflate, br, zstd")).toBe(true);
    });

    it("accepts a wildcard", () => {
      expect(clientAcceptsGzip("*")).toBe(true);
    });

    it("rejects when gzip is disabled via q=0", () => {
      expect(clientAcceptsGzip("gzip;q=0, br")).toBe(false);
    });

    it("explicit gzip quality wins over wildcard", () => {
      expect(clientAcceptsGzip("*;q=1, gzip;q=0")).toBe(false);
    });

    it("rejects when the header is missing or lists other codings", () => {
      expect(clientAcceptsGzip(undefined)).toBe(false);
      expect(clientAcceptsGzip("br, zstd")).toBe(false);
    });
  });

  describe("resolveStaticCacheControl", () => {
    it("marks hashed assets immutable", () => {
      expect(resolveStaticCacheControl("assets/index-I05rxUNB.js")).toBe(
        "public, max-age=31536000, immutable",
      );
    });

    it("requires revalidation for the app shell and other roots", () => {
      expect(resolveStaticCacheControl("index.html")).toBe("no-cache");
      expect(resolveStaticCacheControl("favicon.ico")).toBe("no-cache");
    });
  });

  describe("etags", () => {
    it("round-trips through If-None-Match", () => {
      const etag = makeStaticEtag(1234, 1717171717000);
      expect(etagMatches(etag, etag)).toBe(true);
      expect(etagMatches(`"abc", ${etag}`, etag)).toBe(true);
      expect(etagMatches("*", etag)).toBe(true);
      expect(etagMatches('"abc"', etag)).toBe(false);
      expect(etagMatches(undefined, etag)).toBe(false);
    });

    it("differs when size or mtime changes", () => {
      const base = makeStaticEtag(1234, 1000);
      expect(makeStaticEtag(1235, 1000)).not.toBe(base);
      expect(makeStaticEtag(1234, 2000)).not.toBe(base);
    });

    it("supports bigint sizes from FileSystem.stat", () => {
      expect(makeStaticEtag(1234n, 1000)).toBe(makeStaticEtag(1234, 1000));
    });
  });

  describe("getOrCompressGzip", () => {
    it("produces bytes that gunzip back to the input and caches the result", () => {
      const raw = new TextEncoder().encode("campfire ".repeat(500));
      const first = getOrCompressGzip("k1", raw);
      expect(new Uint8Array(gunzipSync(first))).toEqual(raw);
      expect(first.byteLength).toBeLessThan(raw.byteLength);

      const second = getOrCompressGzip("k1", raw);
      expect(second).toBe(first);
      expect(getStaticGzipCacheStatsForTests().entryCount).toBe(1);
    });

    it("evicts oldest entries once the byte budget is exceeded", () => {
      // Incompressible payloads (random bytes) keep the compressed size
      // close to the input so a handful of entries blow the budget.
      const chunkBytes = Math.ceil(STATIC_GZIP_CACHE_MAX_TOTAL_BYTES / 3);
      const makeChunk = (seed: number) => {
        const chunk = new Uint8Array(chunkBytes);
        // xorshift32 — unlike an LCG's low byte, its output has no short
        // period for gzip to exploit, so the compressed size stays ~equal
        // to the input and a few chunks genuinely exceed the cache budget.
        let state = seed >>> 0 || 1;
        for (let index = 0; index < chunk.length; index += 1) {
          state ^= state << 13;
          state >>>= 0;
          state ^= state >>> 17;
          state ^= state << 5;
          state >>>= 0;
          chunk[index] = (state >>> 24) & 0xff;
        }
        return chunk;
      };

      getOrCompressGzip("a", makeChunk(1));
      getOrCompressGzip("b", makeChunk(2));
      getOrCompressGzip("c", makeChunk(3));
      getOrCompressGzip("d", makeChunk(4));

      const stats = getStaticGzipCacheStatsForTests();
      expect(stats.totalBytes).toBeLessThanOrEqual(STATIC_GZIP_CACHE_MAX_TOTAL_BYTES);
      expect(stats.entryCount).toBeLessThan(4);
      // The most recent entry must survive eviction.
      const freshest = getOrCompressGzip("d", makeChunk(4));
      expect(getStaticGzipCacheStatsForTests().entryCount).toBe(stats.entryCount);
      expect(freshest.byteLength).toBeGreaterThan(0);
    });
  });
});
