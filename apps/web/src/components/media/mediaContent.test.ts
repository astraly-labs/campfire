import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { downloadFile, downloadMedia, readMediaPng } from "./mediaContent";

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

it("copies a data URL image without fetching it", async () => {
  // The desktop renderer's connect-src rejects data: URLs the way fetch rejects a CORS failure.
  using fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  const src = `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`;

  const png = await readMediaPng(src);

  expect(fetch).not.toHaveBeenCalled();
  expect(png.type).toBe("image/png");
  expect([...new Uint8Array(await png.arrayBuffer())]).toEqual(PNG_BYTES);
});

it("decodes percent-escaped bytes in a non-base64 data URL", async () => {
  const escaped = PNG_BYTES.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  const src = `data:image/png,${escaped}`;

  const png = await readMediaPng(src);

  expect([...new Uint8Array(await png.arrayBuffer())]).toEqual(PNG_BYTES);
});

it("accepts any case in the scheme and base64 marker, and escapes in base64", async () => {
  const base64 = btoa(String.fromCharCode(...PNG_BYTES)).replaceAll("=", "%3D");

  const png = await readMediaPng(`DATA:image/png;BASE64,${base64}`);

  expect([...new Uint8Array(await png.arrayBuffer())]).toEqual(PNG_BYTES);
});

it("ignores the URL fragment when decoding a data URL", async () => {
  const src = `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}#preview`;

  const png = await readMediaPng(src);

  expect([...new Uint8Array(await png.arrayBuffer())]).toEqual(PNG_BYTES);
});

it.each(["data:image/png;base64,%%%", "data:image/png"])(
  "reports malformed inline media: %s",
  async (src) => {
    await expect(readMediaPng(src)).rejects.toThrow("This inline media could not be decoded.");
  },
);

it("keeps remote media on the fetch path", async () => {
  const png = new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" });
  using fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(png));

  expect(await readMediaPng("https://example.com/image.png")).toEqual(png);
  expect(fetch).toHaveBeenCalledWith("https://example.com/image.png");
});

it("reads media the renderer cannot fetch through the desktop main process", async () => {
  using fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  const readMedia = vi.fn().mockResolvedValue({
    status: 200,
    mimeType: "image/png",
    data: new Uint8Array(PNG_BYTES),
  });
  vi.stubGlobal("window", { desktopBridge: { readMedia } });
  try {
    const png = await readMediaPng("https://example.com/image.png");

    expect(fetch).toHaveBeenCalledOnce();
    expect(readMedia).toHaveBeenCalledWith("https://example.com/image.png");
    expect([...new Uint8Array(await png.arrayBuffer())]).toEqual(PNG_BYTES);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("downloads", () => {
  const anchor = { href: "", download: "", click: vi.fn() };

  beforeEach(() => {
    anchor.href = "";
    anchor.download = "";
    anchor.click.mockClear();
    vi.stubGlobal("document", { createElement: () => anchor });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:saved");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<!doctype html><title>Questions</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("saves an HTML file under its own name", async () => {
    await downloadFile("https://host/asset/questions.html", "questions-for-the-author.html");

    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.download).toBe("questions-for-the-author.html");
    expect(anchor.href).toBe("blob:saved");
  });

  it("still refuses an HTML page where media was expected", async () => {
    await expect(downloadMedia("https://host/image.png", "image.png")).rejects.toThrow(
      "returned a web page instead of media",
    );
    expect(anchor.click).not.toHaveBeenCalled();
  });

  it("reports a failed fetch instead of saving an error page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );

    await expect(downloadFile("https://host/asset/gone.html", "gone.html")).rejects.toThrow(
      "HTTP 404",
    );
    expect(anchor.click).not.toHaveBeenCalled();
  });
});
