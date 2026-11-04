"use client";

import { useEffect, useRef } from "react";

/**
 * A picture from the chat, opened over it instead of in a new tab: a small modal that closes on
 * Escape, the close button or a click outside the picture, with Save to keep a copy. A native
 * <dialog>, so focus stays inside it and returns to the picture afterwards.
 */
export default function ImagePreview({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const closed = () => onClose();
    dialog.addEventListener("close", closed);
    return () => {
      dialog.removeEventListener("close", closed);
      if (dialog.open) dialog.close();
    };
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      className="image-preview"
      aria-label={name}
      // A click on the backdrop lands on the dialog itself; one on the picture or buttons doesn't.
      onClick={(event) => { if (event.target === event.currentTarget) dialogRef.current?.close(); }}
    >
      <figure>
        {/* A local data or blob URL: nothing for next/image to optimise. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={name} />
        <figcaption>
          <span>{name}</span>
          <a href={src} download={name}>Save</a>
          <button type="button" onClick={() => dialogRef.current?.close()} aria-label="Close the picture">Close</button>
        </figcaption>
      </figure>
    </dialog>
  );
}
