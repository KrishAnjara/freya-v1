"""
FREYA's voice on a GPU that isn't your laptop: Google Colab, or any Linux machine with an NVIDIA GPU.

    python training/serve_remote.py

It installs Ollama, downloads an uncensored Qwen 27B, makes sure it fits on the GPU, puts a login in
front of it (Ollama has none), opens a Cloudflare tunnel, tests itself, then prints one line to run
on your laptop. training/freya_server.ipynb is this same file in a notebook. Nothing is sent to your
laptop until you run that line, and your laptop then runs no model at all.

  --model NAME     an Ollama model, an hf.co/... name, or a .gguf path (e.g. your fine-tune on Drive)
  --ctx N          context window (default: the largest that fits, up to 8192)
  --token TOKEN    keep the same login between runs (default: a new random one)
  --no-tunnel      don't open a tunnel: for a server with its own public address
  --proxy-only     just the login in front of an Ollama that's already running (--upstream, --port)

Colab's rules prohibit web services unrelated to interactive compute, so Google can end a session
like this or act on the account. Free sessions last 12 hours at most, usually less. Cloudflare's quick
tunnels are for testing and the address changes each run. For anything you rely on, rent a GPU and run
this same file there.
"""

import argparse
import hmac
import http.client
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

OLLAMA = "http://127.0.0.1:11434"
PROXY_PORT = 11435
#: Largest first. A T4 has about 15 GB, so the 14 GB file is a tight fit and is checked, not assumed.
MODELS_BY_VRAM = [
    (20, ["huihui_ai/Qwen3.8-abliterated:27b-q4_K_M", "huihui_ai/Qwen3.8-abliterated:27b-q3_K"]),
    (0, ["huihui_ai/Qwen3.8-abliterated:27b-q3_K", "huihui_ai/Qwen3.8-abliterated:27b-q2_K"]),
]
CONTEXTS = [8192, 6144, 4096]
#: The login in front of Ollama only lets these through: chatting, not deleting or pulling models.
ALLOWED = {("POST", "/api/chat"), ("GET", "/api/tags"), ("POST", "/api/show"), ("GET", "/api/ps"), ("GET", "/api/version")}
MAX_BODY_BYTES = 8_000_000


def step(title):
    print(f"\n=== {title} ===", flush=True)


def run(command, **options):
    result = subprocess.run(command, shell=True, **options)
    if result.returncode != 0:
        sys.exit(f"\nStopped: `{command}` failed (exit {result.returncode}). See the output above.")


class Login(BaseHTTPRequestHandler):
    """A token check in front of Ollama, passing replies through as they're written."""

    protocol_version = "HTTP/1.1"
    token = ""
    upstream = OLLAMA

    def log_message(self, *args):  # Never log requests: they hold the conversation.
        pass

    def refuse(self, status, text):
        body = json.dumps({"error": text}).encode()
        # A refused request's body is never read, so this connection can't be used again.
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def forward(self):
        supplied = self.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied.encode(), f"Bearer {self.token}".encode()):
            return self.refuse(401, "wrong or missing token")
        path = urlsplit(self.path).path
        if (self.command, path) not in ALLOWED:
            return self.refuse(403, "not allowed through this server")
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            return self.refuse(413, "request too large")
        body = self.rfile.read(length) if length else None
        target = urlsplit(self.upstream)
        connection = http.client.HTTPConnection(target.hostname, target.port, timeout=600)
        try:
            connection.request(self.command, path, body, {"Content-Type": "application/json"})
            response = connection.getresponse()
            self.send_response(response.status)
            self.send_header("Content-Type", response.getheader("Content-Type", "application/json"))
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while True:
                chunk = response.read1(8192)
                if not chunk:
                    break
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except OSError:
            self.close_connection = True
        finally:
            connection.close()

    do_GET = forward
    do_POST = forward
    do_PUT = forward
    do_DELETE = forward


def start_login(token, upstream, port):
    handler = type("Handler", (Login,), {"token": token, "upstream": upstream})
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def ollama_ready():
    try:
        urllib.request.urlopen(f"{OLLAMA}/api/tags", timeout=2)
        return True
    except OSError:
        return False


def post(path, payload, timeout=900):
    request = urllib.request.Request(f"{OLLAMA}{path}", json.dumps(payload).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def install_ollama():
    if shutil.which("ollama") is None:
        if shutil.which("apt-get"):
            run("apt-get update -qq && apt-get install -y -qq zstd pciutils > /dev/null")
        run("curl -fsSL https://ollama.com/install.sh | sh > /dev/null")
    if ollama_ready():
        return
    env = dict(os.environ, OLLAMA_HOST="127.0.0.1:11434", OLLAMA_KEEP_ALIVE="-1", OLLAMA_NUM_PARALLEL="1", OLLAMA_MAX_LOADED_MODELS="1")
    # Colab keeps its NVIDIA libraries somewhere Ollama doesn't look by default.
    env["LD_LIBRARY_PATH"] = f"/usr/lib64-nvidia:{env.get('LD_LIBRARY_PATH', '')}"
    subprocess.Popen(["ollama", "serve"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if ollama_ready():
            return
        time.sleep(1)
    sys.exit("Ollama didn't start.")


def gpu_gigabytes():
    if shutil.which("nvidia-smi") is None:
        return 0
    result = subprocess.run("nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits", shell=True, capture_output=True, text=True)
    try:
        return int(result.stdout.splitlines()[0]) / 1024
    except (ValueError, IndexError):
        return 0


def share_on_gpu(model):
    """How much of the loaded model is on the GPU, 0 to 1."""
    with urllib.request.urlopen(f"{OLLAMA}/api/ps", timeout=10) as response:
        for entry in json.loads(response.read()).get("models", []):
            if entry.get("name", "").split(":")[0] == model.split(":")[0] and entry.get("size"):
                return entry.get("size_vram", 0) / entry["size"]
    return 0


def create_freya(base, ctx):
    """No SYSTEM and no MESSAGE lines: the app sends the prompt, and example chats would read as real history."""
    # A .gguf from training brings no chat format of its own; library models do.
    chat_format = "RENDERER qwen3.5\nPARSER qwen3.5\n" if base.endswith(".gguf") else ""
    text = f"FROM {base}\n{chat_format}PARAMETER num_ctx {ctx}\nPARAMETER temperature 0.85\nPARAMETER top_p 0.95\nPARAMETER repeat_penalty 1.08\n"
    with open("/tmp/freya.Modelfile", "w", encoding="utf-8") as handle:
        handle.write(text)
    run("ollama create freya -f /tmp/freya.Modelfile > /dev/null")


def load_fitting(candidates, contexts):
    """The first model and context that sit entirely on the GPU. Part on the CPU makes replies crawl."""
    for base in candidates:
        if not re.search(r"\.gguf$", base):
            print(f"Downloading {base} (several minutes, once per session)...", flush=True)
            run(f'ollama pull "{base}"')
        for ctx in contexts:
            create_freya(base, ctx)
            post("/api/generate", {"model": "freya", "prompt": "hi", "stream": False, "keep_alive": -1, "options": {"num_ctx": ctx, "num_predict": 1}})
            share = share_on_gpu("freya")
            print(f"  {base} at context {ctx}: {share:.0%} on the GPU", flush=True)
            if share >= 0.995:
                return base, ctx
    sys.exit("It doesn't fit fully on this GPU, even at the smallest size. In Colab: Runtime > Change runtime type > T4 GPU.")


def self_test():
    """Thinking helped her replies in testing, so it's on if this model has it."""
    shown = post("/api/show", {"model": "freya"}, timeout=60)
    can_think = "thinking" in (shown.get("capabilities") or [])
    started = time.time()
    reply = post("/api/chat", {
        "model": "freya", "stream": False, "think": can_think, "keep_alive": -1,
        "messages": [{"role": "system", "content": "You're texting a friend. Reply in one short line."}, {"role": "user", "content": "why do mirrors flip left and right but not up and down"}],
        "options": {"num_predict": 300},
    })
    seconds = time.time() - started
    speed = reply.get("eval_count", 0) / max(reply.get("eval_duration", 1) / 1e9, 0.001)
    print(f"  Hidden thinking: {'available' if can_think else 'not available'}", flush=True)
    print(f"  Speed: {speed:.0f} tokens a second; that reply took {seconds:.0f}s", flush=True)
    print(f"  Sample: {reply.get('message', {}).get('content', '').strip()[:300]}", flush=True)
    return can_think


def open_tunnel(port):
    if shutil.which("cloudflared") is None:
        run("curl -fsSL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /usr/local/bin/cloudflared")
    process = subprocess.Popen(["cloudflared", "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    found = {}

    def read():
        for line in process.stdout:
            match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if match:
                found.setdefault("url", match.group(0))

    threading.Thread(target=read, daemon=True).start()
    for _ in range(60):
        if "url" in found:
            break
        time.sleep(1)
    if "url" not in found:
        sys.exit("Cloudflare didn't give a tunnel address. Run the cell again.")
    # A new address can take a moment to reach the internet. Asking without a token should get a 401.
    for _ in range(45):
        try:
            urllib.request.urlopen(f"{found['url']}/api/tags", timeout=5)
        except urllib.error.HTTPError as error:
            if error.code == 401:
                break
        except OSError:
            pass
        time.sleep(2)
    return process, found["url"]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="")
    parser.add_argument("--ctx", type=int, default=0)
    parser.add_argument("--token", default="")
    parser.add_argument("--no-tunnel", action="store_true")
    parser.add_argument("--proxy-only", action="store_true")
    parser.add_argument("--upstream", default=OLLAMA)
    parser.add_argument("--port", type=int, default=PROXY_PORT)
    # Colab passes its own arguments to a notebook's kernel; those aren't for this.
    args, _ = parser.parse_known_args()
    token = args.token or secrets.token_urlsafe(24)

    if args.proxy_only:
        start_login(token, args.upstream, args.port)
        print(f"Login on 127.0.0.1:{args.port} in front of {args.upstream}. Ctrl+C to stop.", flush=True)
        while True:
            time.sleep(3600)

    step("1/5 GPU")
    gigabytes = gpu_gigabytes()
    if not gigabytes:
        sys.exit("No GPU found. In Colab: Runtime > Change runtime type > T4 GPU, then run this again.")
    print(f"  {gigabytes:.0f} GB of GPU memory", flush=True)

    step("2/5 Ollama")
    install_ollama()

    step("3/5 The model")
    candidates = [args.model] if args.model else next(models for floor, models in MODELS_BY_VRAM if gigabytes >= floor)
    base, ctx = load_fitting(candidates, [args.ctx] if args.ctx else CONTEXTS)

    step("4/5 Test")
    can_think = self_test()

    step("5/5 Opening it to your laptop")
    start_login(token, OLLAMA, args.port)
    url, tunnel = f"http://THIS-SERVER:{args.port}", None
    if not args.no_tunnel:
        tunnel, url = open_tunnel(args.port)

    extra = f" --ctx {ctx}" + (" --think" if can_think else "")
    print(f"""
================================================================================
 FREYA's voice is up: {base}

 On your laptop, in the freya-v1 folder, run:

     start.bat --remote {url} --key {token}{extra}

 (macOS/Linux: sh start.sh instead of start.bat. Add --prod to use less memory.)

 Keep this running. When it stops she falls back to Groq until you start it again,
 and you'll get a new line to run.
================================================================================
""", flush=True)

    while True:
        time.sleep(30)
        if tunnel and tunnel.poll() is not None:
            tunnel, url = open_tunnel(args.port)
            print(f"\nThe tunnel dropped and came back at a new address. On your laptop run:\n\n    start.bat --remote {url} --key {token}{extra}\n", flush=True)


if __name__ == "__main__":
    main()
