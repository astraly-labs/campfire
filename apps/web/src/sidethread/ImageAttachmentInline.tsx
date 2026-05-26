import type { EnvironmentId, SideThreadImageAttachment } from "@t3tools/contracts";

import { resolveEnvironmentHttpUrl } from "../environments/runtime";

interface Props {
  readonly attachment: SideThreadImageAttachment;
  /** Environment whose HTTP base serves the `/attachments/{id}` blob route. */
  readonly environmentId: EnvironmentId;
}

/**
 * Inline image rendered inside a side-thread message bubble. The persisted
 * attachment carries only an opaque blob `id` (the bytes live in the server's
 * attachment store), so we resolve the playable URL from the id + the
 * environment's HTTP base — the same `/attachments/{id}` route the agent chat
 * uses. We resolve through {@link resolveEnvironmentHttpUrl} (never a relative
 * path) because in remote/Tailscale mode a relative URL silently serves the
 * SPA's index.html instead of the blob.
 *
 * Sized against the drawer width (380px) with a 280px ceiling, matching the
 * GIF renderer so the two media kinds line up in the stream. Clicking opens
 * the full-resolution image in a new tab.
 */
export function ImageAttachmentInline({ attachment, environmentId }: Props) {
  let src: string | null = null;
  try {
    src = resolveEnvironmentHttpUrl({
      environmentId,
      pathname: `/attachments/${encodeURIComponent(attachment.id)}`,
    });
  } catch {
    // Environment HTTP base not resolvable (e.g. disconnected) — fall back to
    // a filename chip below rather than throwing out of render.
    src = null;
  }

  if (!src) {
    return (
      <div className="mt-1 flex min-h-[56px] max-w-[280px] items-center justify-center rounded-md bg-muted/40 px-3 py-2 text-center text-[11px] text-muted-foreground/70 ring-1 ring-border/40">
        {attachment.name}
      </div>
    );
  }

  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="mt-1 block max-w-[280px] cursor-zoom-in overflow-hidden rounded-md bg-muted/40 ring-1 ring-border/40"
      aria-label={`Open image ${attachment.name}`}
    >
      <img
        src={src}
        alt={attachment.name}
        loading="lazy"
        className="block h-auto max-h-[280px] w-full object-cover"
      />
    </a>
  );
}
