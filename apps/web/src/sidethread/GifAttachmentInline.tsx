import type { SideThreadGifAttachment } from "@t3tools/contracts";

export function GifAttachmentInline({
  attachment,
}: {
  readonly attachment: SideThreadGifAttachment;
}) {
  const style =
    attachment.width > 0 && attachment.height > 0
      ? {
          width: Math.min(280, attachment.width),
          aspectRatio: `${attachment.width} / ${attachment.height}`,
        }
      : undefined;
  const className = "mt-2 max-h-56 max-w-full rounded-lg object-contain";
  const usesVideo = attachment.providerId !== undefined || /\.mp4(?:[?#]|$)/iu.test(attachment.url);

  return usesVideo ? (
    <video
      src={attachment.url}
      poster={attachment.previewUrl}
      autoPlay
      loop
      muted
      playsInline
      preload="metadata"
      className={className}
      style={style}
      aria-label="GIF"
    />
  ) : (
    <img
      src={attachment.url}
      alt="GIF"
      loading="lazy"
      referrerPolicy="no-referrer"
      className={className}
      style={style}
    />
  );
}
