/** Runs once when the Next.js server starts. */
export async function register() {
  // Node runtime only: the warm-up talks to Ollama over the local network.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { warmOllama } = await import("@/lib/warm-ollama");
  // Not awaited: the server must not wait ~50s on the local model before accepting requests.
  void warmOllama();
}
