import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { reportError } from "../lib/report-error.ts";

test("raw error text never becomes the displayed message", () => {
  const leaky = new Error("ECONNREFUSED 10.0.0.4:5432 supabase_admin password auth failed");
  const shown = reportError("memory", leaky);
  assert.doesNotMatch(shown, /ECONNREFUSED|10\.0\.0\.4|password|supabase_admin/i);
  assert.match(shown, /memory could not be saved/i);
});

test("every scope yields a calm sentence, and unknown scopes fall back", () => {
  for (const scope of ["chat", "auth", "memory", "profile", "storage", "export", "reflection", "search"]) {
    const shown = reportError(scope, new Error("boom stack trace at line 42"));
    assert.doesNotMatch(shown, /boom|line 42/);
    assert.ok(shown.length > 10 && /[.!]$/.test(shown), `"${shown}" should read as a sentence`);
  }
  assert.equal(reportError("totally-unknown", new Error("x")), "Something went wrong. Please try again.");
});

test("an explicit override is used verbatim", () => {
  assert.equal(reportError("chat", new Error("detail"), "Custom calm line."), "Custom calm line.");
});

test("reporting works server-side without a window", () => {
  assert.equal(typeof window, "undefined");
  assert.doesNotThrow(() => reportError("chat", new Error("no window here")));
});

test("the chat page shows no raw provider or database error text", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  // Interpolating an error's own message into a notification puts upstream detail on screen.
  assert.doesNotMatch(page, /notify\(`[^`]*\$\{\s*error\.message/);
  assert.doesNotMatch(page, /notify\(\s*error instanceof Error \? error\.message/);
  // Native dialogs cannot be styled and were replaced by the in-app ones.
  assert.doesNotMatch(page, /window\.(confirm|prompt|alert)\(/);
});

test("the client log route neither echoes detail nor returns a body", async () => {
  const route = await readFile(new URL("../app/api/client-log/route.ts", import.meta.url), "utf8");
  assert.match(route, /console\.error/);
  assert.match(route, /status: 204/);
  // A 204 carries no body, so nothing logged can be read back by the browser.
  assert.doesNotMatch(route, /NextResponse\.json\(/);
});
