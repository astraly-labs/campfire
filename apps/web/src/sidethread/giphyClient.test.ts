import { describe, expect, it } from "vitest";

import { giphyAttachment } from "./giphyClient";

describe("giphyAttachment", () => {
  it("maps a search result to the durable SideThread wire shape", () => {
    expect(
      giphyAttachment({
        id: "gif-1",
        title: "Ship it",
        url: "https://media.example.test/ship.mp4",
        previewUrl: "https://media.example.test/ship.jpg",
        width: 320,
        height: 180,
      }),
    ).toEqual({
      type: "gif",
      url: "https://media.example.test/ship.mp4",
      previewUrl: "https://media.example.test/ship.jpg",
      width: 320,
      height: 180,
      providerId: "gif-1",
    });
  });
});
