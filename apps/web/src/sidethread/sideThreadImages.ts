import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type SideThreadPostAttachment,
} from "@t3tools/contracts";

import { readFileAsDataUrl } from "../lib/imageCompression";

const SIDE_THREAD_MAX_ATTACHMENTS = 8;

/** The images among picked or pasted files; a clipboard with only text yields none. */
export function imageFiles(files: ArrayLike<File>): File[] {
  return Array.from(files).filter((file) => file.type.startsWith("image/"));
}

export async function readImage(file: File): Promise<SideThreadPostAttachment> {
  if (!file.type.startsWith("image/") || file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    throw new Error("Choose an image smaller than 10 MB.");
  }
  return {
    type: "image",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    dataUrl: await readFileAsDataUrl(file),
  };
}

export function withAddedAttachments(
  current: ReadonlyArray<SideThreadPostAttachment>,
  added: ReadonlyArray<SideThreadPostAttachment>,
): ReadonlyArray<SideThreadPostAttachment> {
  return [...current, ...added].slice(0, SIDE_THREAD_MAX_ATTACHMENTS);
}
