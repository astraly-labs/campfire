/**
 * Pure helpers for staging image attachments in the side-thread composer.
 * Kept DOM-free (the caller injects `makePreviewUrl`/`makeId`) so the
 * validation rules can be unit-tested in isolation. The limits mirror the
 * agent chat composer exactly so both surfaces reject the same payloads.
 *
 * @module sidethread/imageAttachments
 */
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

/** A locally-staged image awaiting send: metadata + a blob preview URL + the File. */
export interface PendingImage {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** `URL.createObjectURL(file)` — revoked by the composer once consumed. */
  readonly previewUrl: string;
  readonly file: File;
}

/** Human-readable form of {@link PROVIDER_SEND_TURN_MAX_IMAGE_BYTES}. */
export const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024),
)} MB`;

export interface AppendPendingImagesResult {
  /** The next pending list (existing + accepted files), capped at the max. */
  readonly images: ReadonlyArray<PendingImage>;
  /** First rejection reason encountered, or `null` if everything was accepted. */
  readonly error: string | null;
}

/**
 * Validate dropped/pasted/picked files and append the accepted ones to the
 * existing pending list. Enforces image-only mime, the per-image byte cap and
 * the per-message attachment count. Non-image / oversized files are skipped
 * (surfaced via `error`); once the count cap is hit we stop accepting more.
 */
export function appendPendingImages(input: {
  readonly existing: ReadonlyArray<PendingImage>;
  readonly files: ReadonlyArray<File>;
  readonly makePreviewUrl: (file: File) => string;
  readonly makeId: () => string;
}): AppendPendingImagesResult {
  const next: PendingImage[] = [...input.existing];
  let error: string | null = null;

  for (const file of input.files) {
    if (!file.type.startsWith("image/")) {
      error = `Unsupported file '${file.name || "attachment"}'. Attach images only.`;
      continue;
    }
    if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      error = `'${file.name || "image"}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} limit.`;
      continue;
    }
    if (next.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
      break;
    }
    next.push({
      id: input.makeId(),
      name: file.name || "image",
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: input.makePreviewUrl(file),
      file,
    });
  }

  return { images: next, error };
}

/** Pull image files out of a clipboard/drag `FileList` (drops non-images). */
export function imageFilesFrom(list: FileList | null | undefined): File[] {
  if (!list || list.length === 0) return [];
  return Array.from(list).filter((file) => file.type.startsWith("image/"));
}
