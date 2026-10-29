export type TranscriptMessage = { role: "user" | "assistant"; content: string };

const MAX_SUMMARY_CHARS = 1800;
const MAX_NOTE_CHARS = 220;

/** Bounded extractive notes for older local turns; no model call or persistence occurs here. */
export function summarizeOlderMessages(messages: TranscriptMessage[]): string {
  const notes = messages.slice(-24).reverse().map((message) => {
    const plain = message.content
      .replace(/```[\s\S]*?```/g, "[code omitted]")
      .replace(/\s+/g, " ")
      .trim();
    if (!plain) return "";
    const clipped = plain.length > MAX_NOTE_CHARS ? `${plain.slice(0, MAX_NOTE_CHARS).trimEnd()}…` : plain;
    return `${message.role === "user" ? "User" : "FREYA"}: ${clipped}`;
  }).filter(Boolean);
  let summary = "";
  for (const note of notes) {
    const next = summary ? `${summary}\n${note}` : note;
    if (next.length > MAX_SUMMARY_CHARS) break;
    summary = next;
  }
  return summary.split("\n").reverse().join("\n");
}
