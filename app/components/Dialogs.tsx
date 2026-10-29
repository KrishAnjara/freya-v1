"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

export type Toast = { id: number; text: string; tone: "info" | "error" };

export type AskRequest = {
  title: string;
  body?: string;
  /** Present for a prompt; absent for a confirm. */
  field?: { label: string; value: string; placeholder?: string; maxLength?: number };
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive and keeps focus on cancel. */
  destructive?: boolean;
};

/**
 * Replaces `window.confirm` / `window.prompt`, which cannot be styled, block the page, and
 * look nothing like the rest of the workspace.
 *
 * Resolves with the entered string for a prompt, `true` for a confirmed confirm, or null when
 * dismissed, so callers read the same way the native calls did.
 */
export function AskDialog({ request, onResolve }: {
  request: AskRequest | null;
  onResolve: (value: string | boolean | null) => void;
}) {
  const [value, setValue] = useState("");
  const panelRef = useRef<HTMLFormElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (request?.field) setValue(request.field.value);
  }, [request]);

  useEffect(() => {
    if (!request) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>("button, input, [href], [tabindex]:not([tabindex='-1'])") ?? [],
    ).filter((element) => !element.hasAttribute("disabled"));

    // A destructive confirm starts on Cancel so Enter never deletes anything by reflex.
    const items = focusables();
    const initial = request.field
      ? items.find((element) => element.tagName === "INPUT")
      : request.destructive
        ? items.find((element) => element.dataset.role === "cancel")
        : items.find((element) => element.dataset.role === "confirm");
    (initial ?? items[0])?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onResolve(null); return; }
      if (event.key !== "Tab") return;
      const current = focusables();
      if (current.length < 2) return;
      const first = current[0];
      const last = current[current.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [request, onResolve]);

  if (!request) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (request.field) {
      const trimmed = value.trim();
      onResolve(trimmed ? trimmed : null);
    } else {
      onResolve(true);
    }
  };

  return (
    <div className="ask-layer">
      <button type="button" className="ask-backdrop" aria-label="Dismiss" onClick={() => onResolve(null)} />
      <form className="ask-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="ask-title" onSubmit={submit}>
        <h2 id="ask-title">{request.title}</h2>
        {request.body && <p className="ask-body">{request.body}</p>}
        {request.field && (
          <label className="ask-field">
            <span>{request.field.label}</span>
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={request.field.placeholder}
              maxLength={request.field.maxLength ?? 120}
              autoComplete="off"
            />
          </label>
        )}
        <div className="ask-actions">
          <button type="button" data-role="cancel" className="ask-cancel" onClick={() => onResolve(null)}>
            {request.cancelLabel ?? "Cancel"}
          </button>
          <button type="submit" data-role="confirm" className={`ask-confirm ${request.destructive ? "is-destructive" : ""}`}>
            {request.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Stacked toasts, anchored to the viewport rather than buried in the transcript. */
export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
          <span className="toast-mark" aria-hidden="true">{toast.tone === "error" ? "!" : "✦"}</span>
          <span className="toast-text">{toast.text}</span>
          <button type="button" className="toast-dismiss" onClick={() => onDismiss(toast.id)} aria-label="Dismiss message">×</button>
        </div>
      ))}
    </div>
  );
}
