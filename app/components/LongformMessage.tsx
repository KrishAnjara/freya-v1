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
  const wakeRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!animate) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let last = performance.now();
    let shownNow = 0;
    // Once caught up it stops, and a new piece of text (the stream going on) starts it again: before,
    // this ran every frame for as long as the message was on screen.
    const tick = (now: number) => {
      const elapsed = (now - last) / 1000;
      last = now;
      // Behind by a lot (a fast stream): jump closer instead of typing for minutes.
      const floor = Math.max(shownNow, target.current - MAX_LAG);
      shownNow = reduce ? target.current : Math.min(target.current, floor + Math.max(1, Math.round(CHARS_PER_SECOND * elapsed)));
      setShown(shownNow);
      frame = shownNow < target.current ? requestAnimationFrame(tick) : 0;
    };
    const wake = () => { if (!frame && shownNow < target.current) { last = performance.now(); frame = requestAnimationFrame(tick); } };
    wakeRef.current = wake;
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); wakeRef.current = () => undefined; };
  }, [animate]);
  useEffect(() => { wakeRef.current(); }, [content.length]);

  const typing = shown < content.length || streaming;
  return (
    <div className={`assistant-body longform-body ${typing ? "is-typing" : ""}`}>
      <MarkdownContent content={animate ? content.slice(0, shown) : content}/>
      {typing && <span className="typing-caret" aria-hidden="true"/>}
    </div>
  );
}
