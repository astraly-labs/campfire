import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { appendPendingImages, imageFilesFrom, type PendingImage } from "./imageAttachments";

// Minimal File stand-in — jsdom's File works, but we only need `type`,
// `size`, and `name`, so a typed cast keeps the fixtures terse.
const mkFile = (name: string, type: string, size: number): File =>
  ({ name, type, size }) as unknown as File;

let idCounter = 0;
const makeId = () => `id-${++idCounter}`;
const makePreviewUrl = (file: File) => `blob:${file.name}`;

const append = (existing: ReadonlyArray<PendingImage>, files: ReadonlyArray<File>) =>
  appendPendingImages({ existing, files, makePreviewUrl, makeId });

describe("appendPendingImages", () => {
  it("accepts image files and maps them to pending images", () => {
    const { images, error } = append([], [mkFile("a.png", "image/png", 1024)]);
    expect(error).toBeNull();
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      previewUrl: "blob:a.png",
    });
  });

  it("rejects non-image files but keeps accepted ones", () => {
    const { images, error } = append(
      [],
      [mkFile("doc.pdf", "application/pdf", 10), mkFile("ok.jpg", "image/jpeg", 10)],
    );
    expect(images).toHaveLength(1);
    expect(images[0]?.name).toBe("ok.jpg");
    expect(error).toMatch(/Attach images only/);
  });

  it("rejects oversized images", () => {
    const tooBig = 11 * 1024 * 1024;
    const { images, error } = append([], [mkFile("huge.png", "image/png", tooBig)]);
    expect(images).toHaveLength(0);
    expect(error).toMatch(/exceeds the .* limit/);
  });

  it("caps the total number of attachments", () => {
    const files = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 2 }, (_, i) =>
      mkFile(`img-${i}.png`, "image/png", 10),
    );
    const { images, error } = append([], files);
    expect(images).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
    expect(error).toMatch(/up to/);
  });

  it("counts the existing list toward the cap", () => {
    const existing: PendingImage[] = Array.from(
      { length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS },
      (_, i) => ({
        id: `e-${i}`,
        name: `e-${i}.png`,
        mimeType: "image/png",
        sizeBytes: 10,
        previewUrl: `blob:e-${i}`,
        file: mkFile(`e-${i}.png`, "image/png", 10),
      }),
    );
    const { images, error } = append(existing, [mkFile("more.png", "image/png", 10)]);
    expect(images).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
    expect(error).toMatch(/up to/);
  });
});

describe("imageFilesFrom", () => {
  it("returns [] for null/empty", () => {
    expect(imageFilesFrom(null)).toEqual([]);
    expect(imageFilesFrom(undefined)).toEqual([]);
  });

  it("keeps only image entries", () => {
    const list = [
      mkFile("a.png", "image/png", 1),
      mkFile("b.txt", "text/plain", 1),
      mkFile("c.gif", "image/gif", 1),
    ] as unknown as FileList;
    // Array.from over our array-like works because it has numeric indices + length.
    const filtered = imageFilesFrom({
      length: list.length,
      0: list[0],
      1: list[1],
      2: list[2],
      item: (i: number) => list[i] ?? null,
    } as unknown as FileList);
    expect(filtered.map((f) => f.name)).toEqual(["a.png", "c.gif"]);
  });
});
