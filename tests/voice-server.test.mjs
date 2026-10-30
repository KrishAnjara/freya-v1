import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

const script = await readFile(new URL("../training/serve_remote.py", import.meta.url), "utf8");

test("the notebook holds the whole server script, and says what it risks", async () => {
  const notebook = JSON.parse(await readFile(new URL("../training/freya_server.ipynb", import.meta.url), "utf8"));
  const code = notebook.cells.find((cell) => cell.cell_type === "code").source.join("");
  assert.ok(code.includes(script.replace(/\r\n/g, "\n")), "run `node scripts/build-server-notebook.mjs` after changing serve_remote.py");
  const words = notebook.cells.find((cell) => cell.cell_type === "markdown").source.join("");
  assert.match(words, /prohibit web services/);
  assert.match(words, /isn't private/);
});

test("the server script keeps out what would hurt: no example chats, no prompt logging, no open door", () => {
  assert.doesNotMatch(script, /^MESSAGE /m);
  assert.match(script, /def log_message\(self, \*args\):/, "requests hold the conversation");
  assert.match(script, /compare_digest/);
  assert.doesNotMatch(script, /api\/(pull|delete|create|push|copy)"\)/, "the outside can chat, not manage models");
});

// The login itself, against a stand-in for Ollama. It needs Python, which the Colab side has anyway.
const python = process.platform === "win32" ? "python" : "python3";
let upstream;
let login;
const PORT = 11499;
const TOKEN = "unit-test-token";

before(async () => {
  upstream = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      if (request.url === "/api/tags") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ models: [{ name: "freya:latest" }] })); return; }
      response.setHeader("content-type", "application/x-ndjson");
      response.write(JSON.stringify({ message: { content: "first " }, echoed: body.length }) + "\n");
      await new Promise((resolve) => setTimeout(resolve, 120));
      response.end(JSON.stringify({ message: { content: "second" }, done: true }) + "\n");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  login = spawn(python, ["training/serve_remote.py", "--proxy-only", "--token", TOKEN, "--port", String(PORT), "--upstream", `http://127.0.0.1:${upstream.address().port}`], { stdio: "ignore" });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await fetch(`http://127.0.0.1:${PORT}/api/version`); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error("the login didn't start");
});

after(() => {
  login?.kill();
  upstream?.close();
});

const call = (path, init = {}, token = TOKEN) => fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });

test("no token, or the wrong one, gets nothing", async () => {
  assert.equal((await call("/api/tags", {}, "")).status, 401);
  assert.equal((await call("/api/tags", {}, "wrong")).status, 401);
  assert.equal((await call("/api/chat", { method: "POST", body: "{}" }, "wrong")).status, 401);
});

test("even with the token, only chatting gets through", async () => {
  for (const path of ["/api/pull", "/api/delete", "/api/create", "/api/generate"]) {
    assert.equal((await call(path, { method: "POST", body: "{}" })).status, 403, path);
  }
  assert.equal((await call("/api/tags", { method: "DELETE" })).status, 403);
});

test("with the token it works, and a reply comes through as it's written", async () => {
  const tags = await call("/api/tags");
  assert.equal(tags.status, 200);
  assert.equal((await tags.json()).models[0].name, "freya:latest");
  const started = Date.now();
  const response = await call("/api/chat", { method: "POST", body: JSON.stringify({ model: "freya", messages: [] }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /ndjson/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const { value } = await reader.read();
  const firstArrived = Date.now() - started;
  assert.match(decoder.decode(value), /first/);
  assert.ok(firstArrived < 110, `the first part wasn't held back (${firstArrived}ms)`);
  let rest = "";
  for (let part = await reader.read(); !part.done; part = await reader.read()) rest += decoder.decode(part.value);
  assert.match(rest, /second/);
});
