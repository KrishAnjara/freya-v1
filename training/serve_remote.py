"""
FREYA's models on a GPU that isn't your laptop: Google Colab, or any Linux machine with an NVIDIA GPU.

    python training/serve_remote.py

It installs Ollama, downloads an uncensored Qwen 27B (it sees images too), makes sure it fits on the
GPU, puts a login in front of it (Ollama has none), opens a Cloudflare tunnel, tests itself, then
prints one line to run on your laptop. training/freya_server.ipynb is this same file in a notebook.
Nothing is sent to your laptop until you run that line, and your laptop then runs no model at all.

Behind the same login and address it also serves, when asked for:
  - a smaller fallback model, for when the big one fails inside the session (out of memory, a crash)
  - an embedding model, so her memory can be matched by meaning
  - pictures (SDXL + SDXL-Lightning, 4 steps): text-to-image, edits of a picture, variations.
    A free T4 (~15 GB) can't hold her text model and the image model (~9 GB while drawing) at
    once unless the text model is the 4B, so a picture unloads it for a moment and the next
    message reloads it (20-40 s). A 24 GB GPU holds both.

  --model NAME           an Ollama model, an hf.co/... name, a .gguf path, or hf:USER/REPO/FILE.gguf
                         (your fine-tune on Hugging Face; private repos use HF_TOKEN)
  --fallback-model NAME  the smaller model (default: Qwen3.5 4B abliterated; "none" to skip)
  --embed-model NAME     for memory (default: nomic-embed-text; "none" to skip)
  --vision-model NAME    a separate vision model, only if the main one can't see (it usually can)
  --images               serve pictures (downloads ~7 GB the first time, in the background)
  --ctx N                context window (default: the largest that fits, up to 8192)
  --token TOKEN          keep the same login between runs (default: a new random one)
  --no-tunnel            don't open a tunnel: for a server with its own public address
  --proxy-only           just the login in front of an Ollama that's already running (--upstream, --port)

Colab's rules prohibit web services unrelated to interactive compute, so Google can end a session
like this or act on the account. Free sessions last 12 hours at most, usually less. Cloudflare's quick
tunnels are for testing and the address changes each run. For anything you rely on, rent a GPU and run
this same file there. To stop: interrupt the cell (or Ctrl+C); the tunnel closes with it.
"""

import argparse
import base64
import contextlib
import gc
import hmac
import http.client
import io
import json
import math
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
DEFAULT_FALLBACK = "huihui_ai/qwen3.5-abliterated:4B"
DEFAULT_EMBED = "nomic-embed-text"
IMAGE_BASE = "stabilityai/stable-diffusion-xl-base-1.0"
IMAGE_LORA = ("ByteDance/SDXL-Lightning", "sdxl_lightning_4step_lora.safetensors")
IMAGE_MODEL_NAME = "SDXL + Lightning 4-step"
#: The login only lets these through: chatting, embeddings, reading what's loaded, and FREYA's own
#: endpoints. Not deleting, pulling or creating models.
ALLOWED = {
    ("POST", "/api/chat"), ("POST", "/api/embed"), ("GET", "/api/tags"), ("POST", "/api/show"), ("GET", "/api/ps"),
    ("GET", "/api/version"), ("GET", "/v1/health"), ("POST", "/v1/images"),
}
MAX_BODY_BYTES = 8_000_000
#: The app refuses these before they get here; this is the second line, for anything else that has the key.
MINORS = re.compile(r"\b(minor|underage|child(ren)?|kids?|teen(ager)?s?|loli|shota|schoolgirl|schoolboy|preteen|(1[0-7]|[1-9])[ -]?(yo|y/o|years?[ -]old))\b", re.I)
SEXUAL = re.compile(r"\b(nude|naked|nsfw|porn\w*|sex\w*|explicit|lingerie|topless|genitals?|erotic)\b", re.I)


def step(title):
    print(f"\n=== {title} ===", flush=True)


def run(command, **options):
    result = subprocess.run(command, shell=True, **options)
    if result.returncode != 0:
        sys.exit(f"\nStopped: `{command}` failed (exit {result.returncode}). See the output above.")


# --- sharing one GPU ----------------------------------------------------------------------------


class GpuTurns:
    """One GPU, two kinds of work: any number of chats at once, or one picture on its own."""

    def __init__(self):
        self._condition = threading.Condition()
        self._chats = 0
        self._picture = False

    @contextlib.contextmanager
    def chat(self):
        with self._condition:
            while self._picture:
                self._condition.wait()
            self._chats += 1
        try:
            yield
        finally:
            with self._condition:
                self._chats -= 1
                self._condition.notify_all()

    @contextlib.contextmanager
    def picture(self):
        with self._condition:
            while self._picture or self._chats:
                self._condition.wait()
            self._picture = True
        try:
            yield
        finally:
            with self._condition:
                self._picture = False
                self._condition.notify_all()


GPU = GpuTurns()


def prepare_body(path, body, embed_on_cpu):
    """Embeddings go to the CPU on a full GPU, so they never push her text model out of memory."""
    if path != "/api/embed" or not body or not embed_on_cpu:
        return body
    try:
        payload = json.loads(body)
    except ValueError:
        return body
    if not isinstance(payload, dict):
        return body
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    payload["options"] = {**options, "num_gpu": 0}
    return json.dumps(payload).encode()


# --- pictures -----------------------------------------------------------------------------------


def parse_image_request(payload):
    """The fields a picture request may have, bounded. Raises ValueError with a reason."""
    if not isinstance(payload, dict):
        raise ValueError("send a JSON object")
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not 2 <= len(prompt.strip()) <= 1200:
        raise ValueError("prompt must be 2-1200 characters")
    if MINORS.search(prompt) and SEXUAL.search(prompt):
        raise ValueError("not something I'll draw")
    negative = payload.get("negative_prompt") if isinstance(payload.get("negative_prompt"), str) else ""
    image = payload.get("image")
    if image is not None and (not isinstance(image, str) or len(image) > 8_000_000 or not re.fullmatch(r"[A-Za-z0-9+/]+=*", image)):
        raise ValueError("image must be base64")
    strength = payload.get("strength", 0.6)
    strength = min(0.9, max(0.2, float(strength))) if isinstance(strength, (int, float)) else 0.6
    size = lambda value: min(1216, max(512, int(value) // 64 * 64)) if isinstance(value, (int, float)) else 1024
    seed = payload.get("seed")
    return {
        "prompt": prompt.strip(), "negative_prompt": negative.strip()[:600], "image": image, "strength": strength,
        "width": size(payload.get("width", 1024)), "height": size(payload.get("height", 1024)),
        "seed": int(seed) if isinstance(seed, int) else secrets.randbelow(2**31),
    }


class ImageEngine:
    """SDXL + SDXL-Lightning, prepared in the background, loaded on the GPU only to draw."""

    def __init__(self, enabled, token=""):
        self.enabled = enabled
        self.token = token or None
        self.ready = threading.Event()
        self.error = ""
        self.pipe = None
        self.resident = False

    def prepare(self):
        """Installs the libraries and downloads the weights to disk. Doesn't touch the GPU."""
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "diffusers>=0.32", "transformers", "accelerate", "safetensors", "peft"], check=True)
            from huggingface_hub import hf_hub_download, snapshot_download
            snapshot_download(IMAGE_BASE, token=self.token, allow_patterns=["*.json", "*.txt", "unet/*fp16.safetensors", "vae/*fp16.safetensors", "text_encoder*/*fp16.safetensors", "tokenizer*/*"])
            hf_hub_download(IMAGE_LORA[0], IMAGE_LORA[1], token=self.token)
            self.ready.set()
            print("  Pictures: ready.", flush=True)
        except Exception as error:  # noqa: BLE001 - reported in /v1/health and to the app
            self.error = f"{type(error).__name__}: {str(error)[:240]}"
            print(f"  Pictures unavailable: {self.error}", flush=True)

    def _load(self):
        import torch
        from diffusers import EulerDiscreteScheduler, StableDiffusionXLPipeline
        from huggingface_hub import hf_hub_download
        pipe = StableDiffusionXLPipeline.from_pretrained(IMAGE_BASE, torch_dtype=torch.float16, variant="fp16", token=self.token)
        pipe.load_lora_weights(hf_hub_download(IMAGE_LORA[0], IMAGE_LORA[1], token=self.token))
        pipe.fuse_lora()
        # Lightning is trained on the "trailing" timesteps; the default spacing makes it blurry.
        pipe.scheduler = EulerDiscreteScheduler.from_config(pipe.scheduler.config, timestep_spacing="trailing")
        pipe.enable_vae_slicing()
        return pipe.to("cuda")

    def release(self):
        if self.pipe is None:
            return
        import torch
        self.pipe = None
        gc.collect()
        torch.cuda.empty_cache()

    def generate(self, request):
        if not self.enabled:
            raise LookupError("pictures aren't switched on (--images)")
        if not self.ready.is_set():
            raise RuntimeError(self.error or "the image model is still downloading; try again in a few minutes")
        import torch
        from PIL import Image
        with GPU.picture():
            started = time.time()
            if self.pipe is None:
                # The 27B leaves no room: let it go for the moment. The next message reloads it.
                if torch.cuda.mem_get_info()[0] / 2**30 < 9.5:
                    unload_text_models()
                self.resident = torch.cuda.mem_get_info()[0] / 2**30 >= 9.5 + 7.5
                self.pipe = self._load()
            generator = torch.Generator("cuda").manual_seed(request["seed"])
            common = {"prompt": request["prompt"], "negative_prompt": request["negative_prompt"] or None, "guidance_scale": 0.0, "generator": generator}
            if request["image"]:
                from diffusers import AutoPipelineForImage2Image
                source = Image.open(io.BytesIO(base64.b64decode(request["image"]))).convert("RGB")
                source = source.resize((request["width"], request["height"]))
                edit = AutoPipelineForImage2Image.from_pipe(self.pipe)
                # Lightning wants four real steps, whatever share of the schedule an edit uses.
                result = edit(image=source, strength=request["strength"], num_inference_steps=math.ceil(4 / request["strength"]), **common).images[0]
            else:
                result = self.pipe(width=request["width"], height=request["height"], num_inference_steps=4, **common).images[0]
            out = io.BytesIO()
            result.save(out, format="JPEG", quality=92)
            if not self.resident:
                self.release()
            return {"image": base64.b64encode(out.getvalue()).decode(), "mime": "image/jpeg", "model": IMAGE_MODEL_NAME, "seed": request["seed"], "ms": int((time.time() - started) * 1000)}


def unload_text_models():
    """Asks Ollama to let go of every loaded model, to make room on the GPU."""
    try:
        with urllib.request.urlopen(f"{OLLAMA}/api/ps", timeout=10) as response:
            loaded = [entry.get("name") for entry in json.loads(response.read()).get("models", [])]
        for name in filter(None, loaded):
            post("/api/generate", {"model": name, "keep_alive": 0}, timeout=60)
    except OSError:
        pass


# --- the login ----------------------------------------------------------------------------------


def health_payload(models, images, capabilities, started_at):
    """What the laptop reads to set itself up: no secrets, just names and states."""
    return {
        "ok": True,
        "models": models,
        "capabilities": capabilities,
        "images": {"enabled": images.enabled, "ready": images.ready.is_set(), **({"error": images.error} if images.error else {})} if images else {"enabled": False, "ready": False},
        "uptime_s": int(time.time() - started_at),
    }


class Login(BaseHTTPRequestHandler):
    """A token check in front of Ollama, passing replies through as they're written."""

    protocol_version = "HTTP/1.1"
    token = ""
    upstream = OLLAMA
    models = {}
    images = None
    embed_on_cpu = False
    started_at = time.time()

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

    def reply_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def capabilities(self):
        try:
            request = urllib.request.Request(f"{self.upstream}/api/show", json.dumps({"model": self.models.get("voice", "freya")}).encode(), {"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=5) as response:
                return json.loads(response.read()).get("capabilities") or []
        except (OSError, ValueError):
            return []

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
        if path == "/v1/health":
            return self.reply_json(200, health_payload(self.models, self.images, self.capabilities(), self.started_at))
        if path == "/v1/images":
            return self.picture(body)
        body = prepare_body(path, body, self.embed_on_cpu)
        guard = GPU.chat() if path in ("/api/chat", "/api/embed") else contextlib.nullcontext()
        with guard:
            self.relay(path, body)

    def picture(self, body):
        if not self.images or not self.images.enabled:
            return self.reply_json(404, {"error": "pictures aren't switched on here (--images)"})
        try:
            request = parse_image_request(json.loads(body or b"{}"))
        except ValueError as error:
            return self.reply_json(400, {"error": str(error)})
        try:
            return self.reply_json(200, self.images.generate(request))
        except RuntimeError as error:
            return self.reply_json(503, {"error": str(error)})
        except Exception as error:  # noqa: BLE001 - a failed picture must not take the server down
            return self.reply_json(500, {"error": f"{type(error).__name__}: {str(error)[:200]}"})

    def relay(self, path, body):
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


def start_login(token, upstream, port, models=None, images=None, embed_on_cpu=False):
    handler = type("Handler", (Login,), {"token": token, "upstream": upstream, "models": models or {"voice": "freya"}, "images": images, "embed_on_cpu": embed_on_cpu, "started_at": time.time()})
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# --- Ollama and the models ----------------------------------------------------------------------


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
    # Two models may be loaded: her voice and the tiny embedding model (kept on the CPU).
    env = dict(os.environ, OLLAMA_HOST="127.0.0.1:11434", OLLAMA_KEEP_ALIVE="-1", OLLAMA_NUM_PARALLEL="1", OLLAMA_MAX_LOADED_MODELS="2")
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


def from_hugging_face(spec, token):
    """hf:USER/REPO/FILE.gguf → a local path. Private repos need HF_TOKEN (Colab: Secrets)."""
    parts = spec[3:].split("/")
    if len(parts) < 3 or not parts[-1].endswith(".gguf"):
        sys.exit("--model hf:... must be hf:USER/REPO/FILE.gguf")
    from huggingface_hub import hf_hub_download
    print(f"Downloading {parts[-1]} from {'/'.join(parts[:2])} on Hugging Face...", flush=True)
    return hf_hub_download("/".join(parts[:2]), "/".join(parts[2:]), token=token or None)


def create_model(name, base, ctx):
    """No SYSTEM and no MESSAGE lines: the app sends the prompt, and example chats would read as real history."""
    # A .gguf from training brings no chat format of its own; library models do.
    chat_format = "RENDERER qwen3.5\nPARSER qwen3.5\n" if base.endswith(".gguf") else ""
    text = f"FROM {base}\n{chat_format}PARAMETER num_ctx {ctx}\nPARAMETER temperature 0.85\nPARAMETER top_p 0.95\nPARAMETER repeat_penalty 1.08\n"
    path = f"/tmp/{name}.Modelfile"
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    run(f"ollama create {name} -f {path} > /dev/null")


def create_freya(base, ctx):
    create_model("freya", base, ctx)


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
    capabilities = shown.get("capabilities") or []
    can_think = "thinking" in capabilities
    started = time.time()
    reply = post("/api/chat", {
        "model": "freya", "stream": False, "think": can_think, "keep_alive": -1,
        "messages": [{"role": "system", "content": "You're texting a friend. Reply in one short line."}, {"role": "user", "content": "why do mirrors flip left and right but not up and down"}],
        "options": {"num_predict": 300},
    })
    seconds = time.time() - started
    speed = reply.get("eval_count", 0) / max(reply.get("eval_duration", 1) / 1e9, 0.001)
    print(f"  Hidden thinking: {'available' if can_think else 'not available'}", flush=True)
    print(f"  Sees images: {'yes' if 'vision' in capabilities else 'no (use --vision-model, or let the app use Grok/Gemini)'}", flush=True)
    print(f"  Speed: {speed:.0f} tokens a second; that reply took {seconds:.0f}s", flush=True)
    print(f"  Sample: {reply.get('message', {}).get('content', '').strip()[:300]}", flush=True)
    return can_think


def pull_in_background(name, label, after=None, token=""):
    """Gets a helper model without holding up the main line: an Ollama name is pulled, an
    hf:USER/REPO/FILE.gguf is downloaded, and a .gguf path (your fine-tune on Drive) is used as is.
    `after(source)` then builds the named model from it."""
    def work():
        source = name
        try:
            if name.startswith("hf:"):
                source = from_hugging_face(name, token)
            elif not name.endswith(".gguf"):
                result = subprocess.run(["ollama", "pull", name], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
                if result.returncode != 0:
                    print(f"  {label} ({name}) couldn't be downloaded: {result.stderr.strip()[-200:]}", flush=True)
                    return
            elif not os.path.exists(name):
                print(f"  {label}: {name} doesn't exist (is Drive mounted?)", flush=True)
                return
            if after:
                after(source)
            print(f"  {label} ready: {name}", flush=True)
        except (OSError, SystemExit) as error:
            print(f"  {label} ({name}) couldn't be set up: {error}", flush=True)
    threading.Thread(target=work, daemon=True).start()


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
    parser.add_argument("--fallback-model", default=DEFAULT_FALLBACK)
    parser.add_argument("--embed-model", default=DEFAULT_EMBED)
    parser.add_argument("--vision-model", default="")
    parser.add_argument("--images", action="store_true")
    parser.add_argument("--ctx", type=int, default=0)
    parser.add_argument("--token", default="")
    parser.add_argument("--no-tunnel", action="store_true")
    parser.add_argument("--proxy-only", action="store_true")
    parser.add_argument("--upstream", default=OLLAMA)
    parser.add_argument("--port", type=int, default=PROXY_PORT)
    # Colab passes its own arguments to a notebook's kernel; those aren't for this.
    args, _ = parser.parse_known_args()
    token = args.token or secrets.token_urlsafe(24)
    hf_token = os.environ.get("HF_TOKEN", "")
    use = lambda name: "" if name.strip().lower() in ("", "none", "off") else name.strip()

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

    images = ImageEngine(args.images, hf_token)
    if args.images:
        # Libraries and weights download while the text model loads; the GPU isn't touched yet.
        threading.Thread(target=images.prepare, daemon=True).start()

    step("2/5 Ollama")
    install_ollama()

    step("3/5 The model")
    model = args.model
    if model.startswith("hf:"):
        model = from_hugging_face(model, hf_token)
    candidates = [model] if model else next(models for floor, models in MODELS_BY_VRAM if gigabytes >= floor)
    base, ctx = load_fitting(candidates, [args.ctx] if args.ctx else CONTEXTS)
    models = {"voice": "freya"}
    fallback = use(args.fallback_model)
    if fallback and fallback != base:
        models["fallback"] = "freya-fallback"
        pull_in_background(fallback, "Fallback model", after=lambda source: create_model("freya-fallback", source, 8192), token=hf_token)
    embed = use(args.embed_model)
    if embed:
        models["embed"] = embed
        pull_in_background(embed, "Memory embeddings")
    vision = use(args.vision_model)
    if vision:
        models["vision"] = vision
        pull_in_background(vision, "Vision model")

    step("4/5 Test")
    can_think = self_test()

    step("5/5 Opening it to your laptop")
    # On a full GPU (a T4 with the 27B), embeddings run on the CPU so they never evict her.
    start_login(token, OLLAMA, args.port, models=models, images=images, embed_on_cpu=gigabytes < 30)
    url, tunnel = f"http://THIS-SERVER:{args.port}", None
    if not args.no_tunnel:
        tunnel, url = open_tunnel(args.port)

    extra = f" --ctx {ctx}" + (" --think" if can_think else "")
    print(f"""
================================================================================
 FREYA's voice is up: {base}
 {"Also: " + ", ".join(f"{role} {name}" for role, name in models.items() if role != "voice") if len(models) > 1 else ""}{" · pictures (downloading in the background)" if args.images else ""}

 On your laptop, in the freya-v1 folder, run:

     start.bat --remote {url} --key {token}{extra}

 (macOS/Linux: sh start.sh instead of start.bat. Add --prod to use less memory.)

 Keep this running. When it stops she falls back to Grok, Gemini or Groq (if
 freya.config.json allows it) until you start it again, and you'll get a new
 line to run. Her memory lives on your laptop, so nothing is lost.
 To stop: interrupt this cell.
================================================================================
""", flush=True)

    try:
        while True:
            time.sleep(30)
            if tunnel and tunnel.poll() is not None:
                tunnel, url = open_tunnel(args.port)
                print(f"\nThe tunnel dropped and came back at a new address. On your laptop run:\n\n    start.bat --remote {url} --key {token}{extra}\n", flush=True)
    except KeyboardInterrupt:
        if tunnel:
            tunnel.terminate()
        print("\nStopped. The tunnel is closed; her laptop falls back until you start this again.", flush=True)


if __name__ == "__main__":
    main()
