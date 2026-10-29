"use client";

import { useEffect, useState } from "react";
import { formatBytes, type AttachmentMeta } from "@/lib/attachments";
import { getAttachment } from "@/lib/attachment-store";

function base64ToBlob(data: string, mime: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

/** Opens (images, PDFs) or downloads (everything else) an attachment from local storage. */
async function openAttachment(item: AttachmentMeta) {
  const stored = await getAttachment(item.id);
  const blob = stored?.data
    ? base64ToBlob(stored.data, item.mime)
    : stored?.text !== undefined
      ? new Blob([stored.text], { type: item.mime || "text/plain" })
      : null;
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  if (item.kind === "image" || item.kind === "pdf" || item.kind === "audio") {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  } else {
    link.download = item.name;
  }
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

function FileGlyph({ kind }: { kind: AttachmentMeta["kind"] }) {
  return <span className="attachment-glyph" aria-hidden="true">{kind === "pdf" ? "PDF" : kind === "audio" ? "AUDIO" : kind === "text" ? "TXT" : "FILE"}</span>;
}

/** The full image, loaded from IndexedDB; the stored thumbnail shows until it arrives. */
function AttachmentImage({ item }: { item: AttachmentMeta }) {
  const [source, setSource] = useState(item.thumb ?? "");
  useEffect(() => {
    let active = true;
    void getAttachment(item.id).then((stored) => {
      if (active && stored?.data) setSource(`data:${item.mime};base64,${stored.data}`);
    });
    return () => { active = false; };
  }, [item.id, item.mime]);
  // Local data URLs: next/image has nothing to optimise here.
  return source
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={source} alt={item.name} loading="lazy" decoding="async"/>
    : <span className="attachment-missing">{item.name}</span>;
}

type AttachmentListProps = {
  items: AttachmentMeta[];
  /** Composer chips: small, removable, never opened. */
  onRemove?: (id: string) => void;
  onUnavailable?: () => void;
};

export default function AttachmentList({ items, onRemove, onUnavailable }: AttachmentListProps) {
  if (!items.length) return null;
  const open = (item: AttachmentMeta) => void openAttachment(item).then((opened) => { if (!opened) onUnavailable?.(); });
  return (
    <div className={`attachment-list ${onRemove ? "pending" : ""}`}>
      {items.map((item) => <div key={item.id} className={`attachment ${item.kind}`}>
        {onRemove
          ? <span className="attachment-face">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {item.kind === "image" && item.thumb ? <img src={item.thumb} alt=""/> : <FileGlyph kind={item.kind}/>}
            <span className="attachment-name">{item.name}</span>
          </span>
          : <button type="button" className="attachment-face" onClick={() => open(item)} title={item.kind === "image" || item.kind === "pdf" ? `Open ${item.name}` : `Download ${item.name}`}>
            {item.kind === "image" ? <AttachmentImage item={item}/> : <><FileGlyph kind={item.kind}/><span className="attachment-name">{item.name}</span><span className="attachment-size">{formatBytes(item.size)}</span></>}
          </button>}
        {onRemove && <button type="button" className="attachment-remove" onClick={() => onRemove(item.id)} aria-label={`Remove ${item.name}`}>×</button>}
      </div>)}
    </div>
  );
}
