import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type SideThreadPostAttachment,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { imageFiles, readImage, withAddedAttachments } from "./sideThreadImages";

const screenshot = new File([new Uint8Array([137, 80, 78, 71])], "image.png", {
  type: "image/png",
});

describe("imageFiles", () => {
  it("keeps the images from a pasted clipboard and drops other files", () => {
    const notes = new File(["hello"], "notes.txt", { type: "text/plain" });
    expect(imageFiles([notes, screenshot])).toEqual([screenshot]);
  });

  it("finds nothing in a plain-text paste, so the text pastes normally", () => {
    expect(imageFiles([])).toEqual([]);
  });
});

describe("readImage", () => {
  it("rejects images over the upload limit before reading them", async () => {
    const huge = new File([new Uint8Array(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1)], "huge.png", {
      type: "image/png",
    });
    await expect(readImage(huge)).rejects.toThrow("smaller than 10 MB");
  });

  it("rejects files that are not images", async () => {
    await expect(readImage(new File(["x"], "x.txt", { type: "text/plain" }))).rejects.toThrow();
  });
});

describe("withAddedAttachments", () => {
  const image = (name: string): SideThreadPostAttachment => ({
    type: "image",
    name,
    mimeType: "image/png",
    sizeBytes: 4,
    dataUrl: "data:image/png;base64,iVBORw==",
  });

  it("appends pasted images after the ones already attached", () => {
    expect(
      withAddedAttachments([image("first")], [image("pasted")]).map((entry) =>
        entry.type === "image" ? entry.name : null,
      ),
    ).toEqual(["first", "pasted"]);
  });

  it("caps a message at eight attachments", () => {
    const current = Array.from({ length: 7 }, (_, index) => image(`kept-${index}`));
    const added = [image("eighth"), image("ninth")];
    const result = withAddedAttachments(current, added);
    expect(result).toHaveLength(8);
    expect(result.at(-1)).toEqual(image("eighth"));
  });
});
