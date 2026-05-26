import type { SideThreadGifAttachment, SideThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vitest";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { persistSideThreadPostAttachments } from "./attachmentNormalizer.ts";

const SIDE_THREAD_ID = "st-thread-abc" as SideThreadId;

// "hello" — parseBase64DataUrl only needs valid base64 + an image/* mime; the
// bytes aren't decoded as an actual image, so a 5-byte payload is enough.
const HELLO_DATA_URL = "data:image/png;base64,aGVsbG8=";

const GIF: SideThreadGifAttachment = {
  kind: "gif",
  url: "https://media.example/cat.mp4" as SideThreadGifAttachment["url"],
  previewUrl: "https://media.example/cat.png" as SideThreadGifAttachment["previewUrl"],
  width: 200 as SideThreadGifAttachment["width"],
  height: 150 as SideThreadGifAttachment["height"],
  providerId: "tenor-1" as SideThreadGifAttachment["providerId"],
};

const withConfig = <A, E>(
  effect: Effect.Effect<A, E, ServerConfig | FileSystem.FileSystem | Path.Path>,
) =>
  effect.pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-st-attach-test-" }),
    ),
  );

it.layer(NodeServices.layer)("persistSideThreadPostAttachments", (it) => {
  it.effect("passes GIF attachments through unchanged", () =>
    withConfig(
      Effect.gen(function* () {
        const result = yield* persistSideThreadPostAttachments({
          sideThreadId: SIDE_THREAD_ID,
          attachments: [GIF],
        });
        expect(result).toEqual([GIF]);
      }),
    ),
  );

  it.effect("writes image bytes to the blob store and returns a persisted record", () =>
    withConfig(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;

        const result = yield* persistSideThreadPostAttachments({
          sideThreadId: SIDE_THREAD_ID,
          attachments: [
            { kind: "image", name: "shot.png", mimeType: "image/png", sizeBytes: 5, dataUrl: HELLO_DATA_URL },
          ],
        });

        expect(result).toHaveLength(1);
        const persisted = result[0]!;
        if (persisted.kind !== "image") throw new Error("expected image attachment");
        expect(persisted.name).toBe("shot.png");
        expect(persisted.mimeType).toBe("image/png");
        expect(persisted.sizeBytes).toBe(5);
        // Id is keyed under the side thread so the serving route resolves it.
        expect(persisted.id.startsWith("st-thread-abc-")).toBe(true);

        // Bytes landed on disk at the shared attachment-store path.
        const filePath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: {
            type: "image",
            id: persisted.id,
            name: persisted.name,
            mimeType: persisted.mimeType,
            sizeBytes: persisted.sizeBytes,
          },
        });
        expect(filePath).not.toBeNull();
        const bytes = yield* fs.readFile(filePath!);
        expect(Buffer.from(bytes).toString("utf8")).toBe("hello");
      }),
    ),
  );

  it.effect("rejects a malformed data URL with an invariant error", () =>
    withConfig(
      Effect.gen(function* () {
        const exit = yield* persistSideThreadPostAttachments({
          sideThreadId: SIDE_THREAD_ID,
          attachments: [
            { kind: "image", name: "bad.png", mimeType: "image/png", sizeBytes: 3, dataUrl: "not-a-data-url" },
          ],
        }).pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause) as { _tag?: string };
          expect(error._tag).toBe("SideThreadCommandInvariantError");
        }
      }),
    ),
  );
});
