/**
 * SideThread attachment normalizer — resolves the *wire* attachments of a
 * `sidethread.message.post` command into their *persisted* form.
 *
 * GIFs reference an external provider URL and carry no bytes, so they pass
 * through unchanged. Upload images carry a base64 `dataUrl` the browser
 * captured; we decode + validate it, write the bytes to the shared
 * attachment blob store, and replace the payload with an opaque `id`. This
 * deliberately reuses orchestration's attachment store + `/attachments/{id}`
 * serving route so the side-thread chat and the agent chat share one
 * pipeline — keeping the event log free of raw image bytes.
 *
 * Runs inside the engine *before* the (pure) decider, which then uses the
 * resolved persisted attachments for both its "text or attachment" invariant
 * and the emitted event payload.
 *
 * @module sidethreads/attachmentNormalizer
 */
// @effect-diagnostics nodeBuiltinImport:off
import { Buffer } from "node:buffer";

import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type SideThreadAttachment,
  type SideThreadId,
  type SideThreadPostAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { SideThreadCommandInvariantError } from "./Errors.ts";

const invariant = (detail: string): SideThreadCommandInvariantError =>
  new SideThreadCommandInvariantError({ commandType: "sidethread.message.post", detail });

/**
 * Convert wire attachments into persisted attachments, writing image bytes to
 * the blob store along the way. Fails with a {@link SideThreadCommandInvariantError}
 * for malformed/oversized payloads or filesystem errors so the failure
 * surfaces as a normal dispatch rejection.
 */
export const persistSideThreadPostAttachments = (input: {
  readonly sideThreadId: SideThreadId;
  readonly attachments: ReadonlyArray<SideThreadPostAttachment>;
}): Effect.Effect<
  ReadonlyArray<SideThreadAttachment>,
  SideThreadCommandInvariantError,
  FileSystem.FileSystem | Path.Path | ServerConfig
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    return yield* Effect.forEach(
      input.attachments,
      (attachment): Effect.Effect<SideThreadAttachment, SideThreadCommandInvariantError> =>
        Effect.gen(function* () {
          // GIFs are already persisted-shaped (external URL, no bytes).
          if (attachment.kind === "gif") {
            return attachment;
          }

          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* invariant(`Invalid image attachment payload for '${attachment.name}'.`);
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* invariant(`Image attachment '${attachment.name}' is empty or too large.`);
          }

          // Key the blob under the side thread (same id scheme as agent-chat
          // threads) so the serving route's id lookup resolves it identically.
          const attachmentId = createAttachmentId(input.sideThreadId);
          if (!attachmentId) {
            return yield* invariant("Failed to create a safe attachment id.");
          }

          const persisted: SideThreadAttachment = {
            kind: "image",
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          // `resolveAttachmentPath` keys off the orchestration `ChatAttachment`
          // shape (`type: "image"`); adapt our persisted record to it so both
          // surfaces write to the exact same on-disk layout.
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: {
              type: "image",
              id: persisted.id,
              name: persisted.name,
              mimeType: persisted.mimeType,
              sizeBytes: persisted.sizeBytes,
            },
          });
          if (!attachmentPath) {
            return yield* invariant(`Failed to resolve persisted path for '${attachment.name}'.`);
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(() =>
              invariant(`Failed to create attachment directory for '${attachment.name}'.`),
            ),
          );
          yield* fileSystem
            .writeFile(attachmentPath, bytes)
            .pipe(
              Effect.mapError(() => invariant(`Failed to persist attachment '${attachment.name}'.`)),
            );

          return persisted;
        }),
      { concurrency: 1 },
    );
  });
