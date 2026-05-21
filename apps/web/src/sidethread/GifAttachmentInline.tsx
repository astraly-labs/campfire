import type { SideThreadGifAttachment } from "@t3tools/contracts";

interface Props {
  readonly attachment: SideThreadGifAttachment;
}

/**
 * Inline GIF rendered inside a side-thread message bubble. We use a
 * silent autoplay/loop `<video>` to mirror Telegram's GIF UX while
 * streaming efficiently — Tenor returns much smaller MP4s than the
 * equivalent animated GIFs. The preview image acts as a poster so the
 * row reserves correct height immediately and reveals once metadata
 * loads.
 *
 * Sized against the drawer width (380px) with a 280px ceiling so a
 * vertical GIF doesn't blow up the message stream.
 */
export function GifAttachmentInline({ attachment }: Props) {
  const aspectRatio = `${attachment.width} / ${attachment.height}`;
  return (
    <div
      className="mt-1 inline-block max-w-[280px] overflow-hidden rounded-md bg-muted/40 ring-1 ring-border/40"
      style={{ width: Math.min(280, attachment.width), aspectRatio }}
    >
      <video
        src={attachment.url}
        poster={attachment.previewUrl}
        autoPlay
        loop
        muted
        playsInline
        // Some browsers (Safari) still prompt on autoplay unless
        // `preload` is loud about wanting metadata. Cheap to include.
        preload="metadata"
        className="size-full object-cover"
        aria-label="GIF attachment"
      />
    </div>
  );
}
