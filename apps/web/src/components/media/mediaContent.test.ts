import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { downloadFile, downloadMedia } from "./mediaContent";

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
