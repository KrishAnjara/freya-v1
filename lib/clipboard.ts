/** Copy text using the modern API, with a DOM-based fallback for restricted contexts. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permissions and secure-context support vary; try the compatibility path.
    }
  }

  if (typeof document === "undefined") return false;
  return copyWithLegacyExecCommand(text, document);
}

export function copyWithLegacyExecCommand(text: string, targetDocument: Document): boolean {
  if (typeof targetDocument.execCommand !== "function") return false;

  const activeElement = targetDocument.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const selection = targetDocument.getSelection();
  const savedRanges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      savedRanges.push(selection.getRangeAt(index).cloneRange());
    }
  }
  const savedInputSelection = activeElement && "selectionStart" in activeElement
    ? { start: activeElement.selectionStart, end: activeElement.selectionEnd }
    : null;

  const textarea = targetDocument.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-10000px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";

  try {
    targetDocument.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return targetDocument.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (activeElement?.isConnected) activeElement.focus({ preventScroll: true });
    if (savedInputSelection && activeElement && "setSelectionRange" in activeElement) {
      try {
        activeElement.setSelectionRange(savedInputSelection.start, savedInputSelection.end);
      } catch {
        // Some input types do not support text-selection restoration.
      }
    }
    if (selection) {
      selection.removeAllRanges();
      for (const range of savedRanges) {
        try {
          selection.addRange(range);
        } catch {
          // The selected node may have been removed while the copy ran.
        }
      }
    }
  }
}
