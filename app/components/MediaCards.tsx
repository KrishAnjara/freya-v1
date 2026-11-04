"use client";

import { useEffect, useRef, useState } from "react";
import MarkdownContent from "@/app/components/MarkdownContent";
import ImagePreview from "@/app/components/ImagePreview";
import { getAttachment } from "@/lib/attachment-store";
import type { AttachmentMeta } from "@/lib/attachments";

export type VisualizationInfo = { title: string; status: "loading" | "ready" | "error"; error?: string; refining?: boolean };
export type PictureInfo = {
  status: "loading" | "ready" | "error";
  prompt: string;
  kind?: "generated" | "svg";
  model?: string;
  /** The prompt as her image server's local refiner rewrote it (spelling fixed, detail added). */
  refined?: string;
  /** Why a drawing was made instead of a generated image. */
  reason?: string;
  svg?: string;
  error?: string;
};

const FALLBACK_REASONS: Record<string, string> = {
  quota: "image generation has no quota on this API key",
  unavailable: "the image model didn't respond",
  "not-configured": "no image model is configured",
};

/** A /visualize result in the thread: its form can be put back on the canvas at any time. */
export function VisualizationCard({ info, onShow, onRefine, tagged = false }: { info: VisualizationInfo; onShow: () => void; onRefine?: () => void; tagged?: boolean }) {
  return <div className={`media-card visualization-card status-${info.status}`}>
    <div className="media-card-kicker">3D VISUALISATION</div>
    <div className="media-card-title">{info.status === "loading" ? `${info.refining ? "Refining" : "Composing"} ${info.title}…` : info.status === "error" ? (info.error || "That didn't work.") : info.title}</div>
    {info.status === "ready" && <div className="media-card-actions">
      <button type="button" onClick={onShow}>Show on canvas</button>
      {onRefine && <button type="button" onClick={onRefine} aria-pressed={tagged}>{tagged ? "Refining…" : "Refine"}</button>}
    </div>}
  </div>;
}

/** Styles a picture can be redrawn in (the server's list in lib/image-generation, by key). */
export const PICTURE_STYLES: [string, string][] = [
  ["photo", "Photo"], ["cinematic", "Cinematic"], ["illustration", "Illustration"], ["anime", "Anime"], ["watercolor", "Watercolour"],
  ["oil", "Oil painting"], ["render", "3D render"], ["pixel", "Pixel art"], ["sketch", "Sketch"],
];

/** The label under a picture: what it is, honestly, plus ways to refine it, vary it or restyle it. */
export function PictureCard({ info, onRefine, onVariation, onStyle }: { info: PictureInfo; onRefine: () => void; onVariation?: () => void; onStyle?: (style: string) => void }) {
  if (info.status === "loading") return <div className="media-card picture-card status-loading" role="status"><div className="media-card-kicker">PICTURE</div><div className="media-card-title">Making it…</div></div>;
  if (info.status === "error") return <div className="media-card picture-card status-error"><div className="media-card-kicker">PICTURE</div><div className="media-card-title">{info.error || "That picture couldn't be made."}</div></div>;
  return <div className={`media-card picture-card kind-${info.kind}`}>
    {info.kind === "svg" && info.svg && <MarkdownContent content={`\`\`\`svg\n${info.svg}\n\`\`\``}/>}
    <div className="media-card-kicker">{info.kind === "generated" ? `GENERATED IMAGE${info.model ? ` · ${info.model}` : ""}` : "SVG DRAWING · NOT A GENERATED IMAGE"}</div>
    <div className="media-card-note">
      {info.kind === "svg" ? `Drawn as vector shapes because ${FALLBACK_REASONS[info.reason ?? ""] ?? "image generation is unavailable"}.` : info.prompt}
    </div>
    {info.kind === "generated" && info.refined && <details className="media-card-refined"><summary>Drawn as</summary><p>{info.refined}</p></details>}
    <div className="media-card-actions">
      <button type="button" onClick={onRefine}>Refine</button>
      {onVariation && <button type="button" onClick={onVariation} title="Another take on this picture">Variation</button>}
      {onStyle && <select aria-label="Redraw in a style" value="" onChange={(event) => { if (event.target.value) onStyle(event.target.value); }}>
        <option value="">Style…</option>
        {PICTURE_STYLES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>}
    </div>
  </div>;
}

/**
 * A generated picture, shown like any picture in a chat: just the image. Everything else (view it
 * large, save it, change it, another take, a style, what it was drawn from) is in the ⋯ menu at its
 * top-right corner. While it's being made: a small "sending a picture" bubble; if it failed, a line
 * saying so, plainly.
 */
export function PictureMessage({ info, image, onEdit, onVariation, onStyle, onCopyPrompt }: {
  info: PictureInfo;
  image?: AttachmentMeta;
  onEdit?: () => void;
  onVariation?: () => void;
  onStyle?: (style: string) => void;
  onCopyPrompt?: () => void;
}) {
  const [source, setSource] = useState("");
  const [menu, setMenu] = useState<"" | "main" | "styles">("");
  const [viewing, setViewing] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!image) return;
    let active = true;
    setSource(image.thumb ?? "");
    void getAttachment(image.id).then((stored) => { if (active && stored?.data) setSource(`data:${image.mime};base64,${stored.data}`); });
    return () => { active = false; };
  }, [image]);
  // A click anywhere else, or Escape, closes the menu.
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menuRef.current?.contains(event.target as Node)) setMenu("");
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, [menu]);

  if (info.status === "loading") return <div className="picture-pending" role="status">sending a picture…</div>;
  if (info.status === "error") return <div className="picture-failed">{info.error || "That picture couldn't be made."}</div>;
  if (info.kind === "svg") return <PictureCard info={info} onRefine={onEdit ?? (() => undefined)} onVariation={onVariation} onStyle={onStyle}/>;
  const choose = (action?: () => void) => () => { setMenu(""); action?.(); };
  return <div className="picture-message">
    {source
      // A local data URL: nothing for next/image to optimise.
      // eslint-disable-next-line @next/next/no-img-element
      ? <button type="button" className="picture-message-image" onClick={() => setViewing(true)} aria-label="View the picture"><img src={source} alt={info.prompt}/></button>
      : <div className="picture-failed">That picture is no longer stored in this browser.</div>}
    {source && <div className="picture-menu" ref={menuRef}>
      <button type="button" className="picture-menu-button" aria-label="Picture options" aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={() => setMenu((open) => open ? "" : "main")}>⋯</button>
      {menu === "main" && <div className="picture-menu-list" role="menu">
        <button type="button" role="menuitem" onClick={choose(() => setViewing(true))}>View</button>
        <a role="menuitem" href={source} download={image?.name ?? "freya-picture.png"} onClick={() => setMenu("")}>Save</a>
        {onEdit && <button type="button" role="menuitem" onClick={choose(onEdit)}>Change it…</button>}
        {onVariation && <button type="button" role="menuitem" onClick={choose(onVariation)}>Another take</button>}
        {onStyle && <button type="button" role="menuitem" onClick={() => setMenu("styles")}>Redraw as…</button>}
        {onCopyPrompt && <button type="button" role="menuitem" onClick={choose(onCopyPrompt)}>Copy prompt</button>}
      </div>}
      {menu === "styles" && onStyle && <div className="picture-menu-list" role="menu">
        {PICTURE_STYLES.map(([key, label]) => <button type="button" role="menuitem" key={key} onClick={choose(() => onStyle(key))}>{label}</button>)}
      </div>}
    </div>}
    {viewing && source && <ImagePreview src={source} name={info.refined || info.prompt} onClose={() => setViewing(false)}/>}
  </div>;
}
