"use client";

import MarkdownContent from "@/app/components/MarkdownContent";

export type VisualizationInfo = { title: string; status: "loading" | "ready" | "error"; error?: string };
export type PictureInfo = {
  status: "loading" | "ready" | "error";
  prompt: string;
  kind?: "generated" | "svg";
  model?: string;
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
export function VisualizationCard({ info, onShow, onRefine }: { info: VisualizationInfo; onShow: () => void; onRefine: () => void }) {
  return <div className={`media-card visualization-card status-${info.status}`}>
    <div className="media-card-kicker">3D VISUALISATION</div>
    <div className="media-card-title">{info.status === "loading" ? `Composing ${info.title}…` : info.status === "error" ? (info.error || "That didn't work.") : info.title}</div>
    {info.status === "ready" && <div className="media-card-actions">
      <button type="button" onClick={onShow}>Show on canvas</button>
      <button type="button" onClick={onRefine}>Refine</button>
    </div>}
  </div>;
}

/** The label under a picture: what it is, honestly, plus a way to refine it. */
export function PictureCard({ info, onRefine }: { info: PictureInfo; onRefine: () => void }) {
  if (info.status === "loading") return <div className="media-card picture-card status-loading" role="status"><div className="media-card-kicker">PICTURE</div><div className="media-card-title">Making it…</div></div>;
  if (info.status === "error") return <div className="media-card picture-card status-error"><div className="media-card-kicker">PICTURE</div><div className="media-card-title">{info.error || "That picture couldn't be made."}</div></div>;
  return <div className={`media-card picture-card kind-${info.kind}`}>
    {info.kind === "svg" && info.svg && <MarkdownContent content={`\`\`\`svg\n${info.svg}\n\`\`\``}/>}
    <div className="media-card-kicker">{info.kind === "generated" ? `GENERATED IMAGE${info.model ? ` · ${info.model}` : ""}` : "SVG DRAWING · NOT A GENERATED IMAGE"}</div>
    <div className="media-card-note">
      {info.kind === "svg" ? `Drawn as vector shapes because ${FALLBACK_REASONS[info.reason ?? ""] ?? "image generation is unavailable"}.` : info.prompt}
    </div>
    <div className="media-card-actions"><button type="button" onClick={onRefine}>Refine</button></div>
  </div>;
}
