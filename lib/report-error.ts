/**
 * Sends failure detail to the server and returns the sentence to show instead.
 *
 * Raw provider, database and network errors are useful to whoever runs the app and noise to
 * whoever is using it — sometimes worse than noise, since they can leak configuration and
 * upstream internals. Detail goes to `/api/client-log`; the reader gets plain language.
 */

/** Short, human sentences keyed by the area that failed. */
const FRIENDLY: Record<string, string> = {
  chat: "FREYA could not finish that reply. Try again in a moment.",
  auth: "That sign-in did not go through. Check the details and try again.",
  memory: "That memory could not be saved right now.",
  profile: "The character dossier could not be saved right now.",
  storage: "This browser could not save your conversation.",
  export: "That conversation could not be exported.",
  reflection: "Reflection could not be completed right now.",
  search: "Search is unavailable right now.",
};

const GENERIC = "Something went wrong. Please try again.";

function detailOf(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Logs `error` server-side under `scope` and returns the message to display.
 * The report is fire-and-forget: a failing logger must never surface to the reader.
 */
export function reportError(scope: string, error: unknown, override?: string): string {
  const detail = detailOf(error);
  if (typeof window !== "undefined") {
    try {
      const body = JSON.stringify({ scope, message: override ?? FRIENDLY[scope] ?? GENERIC, detail });
      // keepalive lets the report survive a navigation triggered by the same failure.
      void fetch("/api/client-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Reporting is best-effort.
    }
  }
  return override ?? FRIENDLY[scope] ?? GENERIC;
}
