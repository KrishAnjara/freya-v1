"use client";

import { useEffect, useRef } from "react";

/**
 * A picture from the chat, opened over it instead of in a new tab: a small modal that closes on
 * Escape, the close button or a click outside the picture, with Save to keep a copy. A native
 * <dialog>, so focus stays inside it and returns to the picture afterwards.
 *
 * Closing is driven from here (onClose), never from the dialog's own "close" event: that event is
 * queued, so in development (React runs effects twice) the cleanup's close() fired it after the
 * dialog had reopened, and the preview vanished the moment it opened.
 */
export default function ImagePreview({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
    }
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="image-preview"
      aria-label={name}
      // Escape: close it ourselves.
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      // A click on the backdrop lands on the dialog itself; one on the picture or buttons doesn't.
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <figure>
        {/* A local data or blob URL: nothing for next/image to optimise. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={name} />
        <figcaption>
          <a href={src} download={/\.(png|jpe?g|webp)$/i.test(name) ? name : "freya-picture.png"}>Save</a>
          <button type="button" onClick={onClose} aria-label="Close the picture">Close</button>
        </figcaption>
      </figure>
    </dialog>
  );
}
