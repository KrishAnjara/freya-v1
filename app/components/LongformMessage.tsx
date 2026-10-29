"use client";

import { useEffect, useRef, useState } from "react";
import MarkdownContent from "@/app/components/MarkdownContent";

/** Typing speed for composed pieces, and how far the text may lag before it catches up. */
const CHARS_PER_SECOND = 110;
const MAX_LAG = 700;

/**
 * A composed piece (essay, letter, story) delivered as one message and typed out.
 *
 * Whether to animate is decided at mount: a piece already finished when it first renders
 * (history, a reload, a switched conversation) appears whole and never replays.
 */
export default function LongformMessage({ content, streaming }: { content: string; streaming: boolean }) {
  const [animate] = useState(streaming);
  const [shown, setShown] = useState(animate ? 0 : content.length);
  const target = useRef(content.length);
  target.current = content.length;

  useEffect(() => {
    if (!animate) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const elapsed = (now - last) / 1000;
      last = now;
      setShown((current) => {
        if (reduce) return target.current;
        // Behind by a lot (a fast stream): jump closer instead of typing for minutes.
        const floor = Math.max(current, target.current - MAX_LAG);
        return Math.min(target.current, floor + Math.max(1, Math.round(CHARS_PER_SECOND * elapsed)));
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animate]);

  const typing = shown < content.length || streaming;
  return (
    <div className={`assistant-body longform-body ${typing ? "is-typing" : ""}`}>
      <MarkdownContent content={animate ? content.slice(0, shown) : content}/>
      {typing && <span className="typing-caret" aria-hidden="true"/>}
    </div>
  );
}
