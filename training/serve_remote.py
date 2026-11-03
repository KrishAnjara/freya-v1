"""
FREYA's models on a GPU that isn't your laptop: Google Colab, or any Linux machine with an NVIDIA GPU.

    python training/serve_remote.py

It installs Ollama, downloads her voice (Dark Forest 20B, an uncensored roleplay model), makes sure it
fits on the GPU, puts a login in front of it (Ollama has none), opens a Cloudflare tunnel, tests
itself, then prints one line to run on your laptop. training/freya_server.ipynb is this same file in
a notebook. Nothing is sent to your laptop until you run that line, and your laptop runs no model.

Behind the same login and address it also serves:
  - a helper model (Qwen3.5 4B abliterated): her fallback voice when the big one fails inside the
    session, her eyes (Dark Forest can't see images), and the picture-prompt refiner
  - an embedding model, so her memory can be matched by meaning
  - pictures (--images): Qwen-Image 2.1, uncensored, Q4_K_M, run by a headless ComfyUI. Every
    request is first spell- and grammar-checked and rewritten into a vivid, realistic, exaggerated
    prompt by the helper model, on this machine. Text-to-image, edits of a picture, variations.
    A free T4 (~15 GB) can't hold her voice and the image model at once, so a picture unloads her
    voice for a moment and the next message reloads it (20-40 s). On a T4 a picture takes minutes.

  --model NAME           an Ollama model, an hf.co/... name, a .gguf path, or hf:USER/REPO/FILE.gguf
                         (your fine-tune on Hugging Face; private repos use HF_TOKEN)
  --chat-format FORMAT   alpaca | chatml | model (the model's own). Dark Forest uses alpaca.
  --fallback-model NAME  the helper model (default: Qwen3.5 4B abliterated; "none" to skip)
  --embed-model NAME     for memory (default: nomic-embed-text; "none" to skip)
  --vision-model NAME    what reads images when her voice can't (default: the helper model)
  --images               serve pictures (downloads ~15 GB the first time, in the background)
  --image-steps N        sampling steps per picture (default 20; the official workflow uses 25)
  --ctx N                context window (default: the largest that fits)
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
from urllib.parse import urlencode, urlsplit

OLLAMA = "http://127.0.0.1:11434"
PROXY_PORT = 11435
DARK_FOREST = "hf.co/DavidAU/Dark-Forest-V1-Ultra-Quality-20b-GGUF"
#: Largest first. Dark Forest has a 4096-token window and a large memory cache per token, so the
#: quant is chosen to leave room for it (with the cache in 8-bit); the fit is checked, not assumed.
MODELS_BY_VRAM = [
    (20, [f"{DARK_FOREST}:Q5_K_M", f"{DARK_FOREST}:Q4_K_M"]),
    (0, [f"{DARK_FOREST}:Q3_K_L", f"{DARK_FOREST}:Q3_K_M"]),
]
#: The uncensored Qwen 27B: what writes training conversations (colab_run --make-corpus), and a
#: --model choice for a voice that reasons better and sees images, at the cost of Dark Forest's roleplay.
QWEN_BY_VRAM = [
    (20, ["huihui_ai/Qwen3.8-abliterated:27b-q4_K_M", "huihui_ai/Qwen3.8-abliterated:27b-q3_K"]),
    (0, ["huihui_ai/Qwen3.8-abliterated:27b-q3_K", "huihui_ai/Qwen3.8-abliterated:27b-q2_K"]),
]
QWEN_CONTEXTS = [8192, 6144, 4096]
#: Dark Forest is a Llama-2 merge trained for 4096 tokens; longer windows only make it ramble.
CONTEXTS = [4096]
DEFAULT_FALLBACK = "huihui_ai/qwen3.5-abliterated:4B"
DEFAULT_EMBED = "nomic-embed-text"
#: Qwen-Image 2.1, uncensored quantisation, and its companions (all in one repository).
IMAGE_REPO = "abenzerps/Qwen-Image-2.1-Uncensored-Quantized"
IMAGE_FILES = {
    "diffusion_models": "qwen-image-2.1-UC-Q4_K_M.gguf",
    "text_encoders": "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
    "vae": "vae/qwen_image_2.1_vae_bf16.safetensors",
}
IMAGE_MODEL_NAME = "Qwen-Image 2.1 uncensored (Q4_K_M)"
COMFY_DIR = os.environ.get("FREYA_COMFY_DIR", "/content/ComfyUI")
COMFY = "http://127.0.0.1:8188"
#: The login only lets these through: chatting, embeddings, reading what's loaded, and FREYA's own
#: endpoints. Not deleting, pulling or creating models.
ALLOWED = {
    ("POST", "/api/chat"), ("POST", "/api/embed"), ("GET", "/api/tags"), ("POST", "/api/show"), ("GET", "/api/ps"),
    ("GET", "/api/version"), ("GET", "/v1/health"), ("POST", "/v1/images"),
}
MAX_BODY_BYTES = 8_000_000
#: The app refuses these before they get here; this is the second line, for anything else that has
#: the key, and it is checked again on what the prompt refiner writes.
MINORS = re.compile(r"\b(minor|underage|child(ren)?|kids?|teen(ager)?s?|loli|shota|schoolgirl|schoolboy|preteen|(1[0-7]|[1-9])[ -]?(yo|y/o|years?[ -]old))\b", re.I)
SEXUAL = re.compile(r"\b(nude|naked|nsfw|porn\w*|sex\w*|explicit|lingerie|topless|genitals?|erotic)\b", re.I)

#: Chat templates for models whose GGUF carries none (Dark Forest). Ollama's own template is kept for "model".
TEMPLATES = {
    "alpaca": (
        '{{- range .Messages }}{{- if eq .Role "system" }}{{ .Content }}\n\n'
        '{{- else if eq .Role "user" }}### Instruction:\n{{ .Content }}\n\n'
        '{{- else if eq .Role "assistant" }}### Response:\n{{ .Content }}\n\n{{- end }}{{- end }}### Response:\n',
        ["### Instruction:", "### Response:", "</s>"],
    ),
    "chatml": (
        '{{- range .Messages }}<|im_start|>{{ .Role }}\n{{ .Content }}<|im_end|>\n{{ end }}<|im_start|>assistant\n',
        ["<|im_start|>", "<|im_end|>"],
    ),
}


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


def blocked(text):
    return bool(MINORS.search(text) and SEXUAL.search(text))


def parse_image_request(payload):
    """The fields a picture request may have, bounded. Raises ValueError with a reason."""
    if not isinstance(payload, dict):
        raise ValueError("send a JSON object")
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not 2 <= len(prompt.strip()) <= 1200:
        raise ValueError("prompt must be 2-1200 characters")
    instruction = payload.get("instruction") if isinstance(payload.get("instruction"), str) else ""
    if blocked(prompt) or blocked(instruction):
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
        "prompt": prompt.strip(), "instruction": instruction.strip()[:1200], "negative_prompt": negative.strip()[:600], "image": image,
        "strength": strength, "width": size(payload.get("width", 1024)), "height": size(payload.get("height", 1024)),
        "refine": payload.get("refine", True) is not False,
        "seed": int(seed) if isinstance(seed, int) else secrets.randbelow(2**31),
    }


REFINER_PROMPT = """You rewrite picture requests for an image model. Do two things, in this order:
1. Fix spelling and grammar, and work out what they actually meant.
2. Rewrite it as one vivid English paragraph (60-140 words) describing the finished picture: the subject first, then pose, expression, clothing or texture, setting, light, camera and lens, colours, mood. Push it further than they did: more dramatic light, stronger emotion, richer detail, bolder composition, photorealistic unless they asked for a style. Keep every detail they gave; invent nothing that changes the subject.

Adult content between adults is allowed and you don't soften or censor it. Never sexualise anyone who is or looks under 18, never add nudity or sexual content they didn't ask for, and never depict a real, named person sexually. If the request does any of those, reply only: REFUSE.
Reply with the rewritten prompt only: no preamble, no quotes, no notes."""

EDIT_REFINER_PROMPT = """You rewrite picture-edit instructions for an image editing model. Fix spelling and grammar, then state the change as one clear, specific English instruction (15-60 words): what to change, what to keep exactly as it is, and the look to aim for (realistic, vivid, bolder than asked). Adult content between adults is allowed. Never sexualise anyone who is or looks under 18, never add nudity they didn't ask for. If the request does that, reply only: REFUSE.
Reply with the instruction only."""


def refine_prompt(text, model, edit=False, timeout=120):
    """Spell-, grammar- and detail-pass by the local helper model. Falls back to the text as given."""
    if not model:
        return text, False
    try:
        reply = post("/api/chat", {
            "model": model, "stream": False, "think": False, "keep_alive": 0,
            "messages": [{"role": "system", "content": EDIT_REFINER_PROMPT if edit else REFINER_PROMPT}, {"role": "user", "content": text}],
            "options": {"temperature": 0.7, "num_predict": 320},
        }, timeout=timeout)
    except (OSError, ValueError):
        return text, False
    refined = re.sub(r"<think>[\s\S]*?</think>", "", reply.get("message", {}).get("content", "")).strip().strip('"').strip()
    if refined.upper().startswith("REFUSE") or blocked(refined):
        raise ValueError("not something I'll draw")
    if len(refined) < 10:
        return text, False
    return refined[:1500], True


def comfy_workflow(request, prompt, steps, source_name=None):
    """ComfyUI's API graph for Qwen-Image 2.1, as in Comfy-Org's official templates (t2i and edit)."""
    graph = {
        "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": os.path.basename(IMAGE_FILES["diffusion_models"])}},
        "2": {"class_type": "QwenImage21Cache", "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": os.path.basename(IMAGE_FILES["text_encoders"]), "type": "qwen_image", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": os.path.basename(IMAGE_FILES["vae"])}},
        "5": {"class_type": "TextEncodeQwenImage21", "inputs": {"clip": ["3", 0], "prompt": prompt, "negative_prompt": request["negative_prompt"], "resolution": 1024}},
        "7": {"class_type": "KSampler", "inputs": {
            "model": ["2", 0], "positive": ["5", 0], "negative": ["5", 1], "seed": request["seed"], "steps": steps,
            "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1,
        }},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["4", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "freya"}},
    }
    if source_name:
        # An edit: the picture goes into the encoder, which also gives the latent at its own size.
        graph["10"] = {"class_type": "LoadImage", "inputs": {"image": source_name}}
        graph["5"]["inputs"].update({"vae": ["4", 0], "images.image_1": ["10", 0]})
        graph["7"]["inputs"]["latent_image"] = ["5", 2]
    else:
        graph["6"] = {"class_type": "EmptyLatentImage", "inputs": {"width": request["width"], "height": request["height"], "batch_size": 1}}
        graph["7"]["inputs"]["latent_image"] = ["6", 0]
    return graph


def comfy(path, payload=None, timeout=30):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(f"{COMFY}{path}", data, {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read()
        return json.loads(body) if body[:1] in (b"{", b"[") else body


class ImageEngine:
    """Qwen-Image 2.1 through a headless ComfyUI: set up in the background, on the GPU only to draw."""

    def __init__(self, enabled, token="", refiner="", steps=20):
        self.enabled = enabled
        self.token = token or None
        self.refiner = refiner
        self.steps = steps
        self.ready = threading.Event()
        self.error = ""
        self.process = None

    def prepare(self):
        """Installs ComfyUI with the GGUF loader, downloads the three model files, starts ComfyUI."""
        try:
            if not os.path.isdir(COMFY_DIR):
                subprocess.run(["git", "clone", "-q", "--depth", "1", "https://github.com/comfyanonymous/ComfyUI", COMFY_DIR], check=True)
            nodes = os.path.join(COMFY_DIR, "custom_nodes", "ComfyUI-GGUF")
            if not os.path.isdir(nodes):
                # The fork with Qwen-Image 2.1 support, as the model's card says.
                subprocess.run(["git", "clone", "-q", "--depth", "1", "https://github.com/leejet/ComfyUI-GGUF", nodes], check=True)
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", os.path.join(COMFY_DIR, "requirements.txt"), "-r", os.path.join(nodes, "requirements.txt")], check=True)
            from huggingface_hub import hf_hub_download
            for folder, name in IMAGE_FILES.items():
                target = os.path.join(COMFY_DIR, "models", folder, os.path.basename(name))
                if not os.path.exists(target):
                    print(f"  Pictures: downloading {os.path.basename(name)}...", flush=True)
                    path = hf_hub_download(IMAGE_REPO, name, token=self.token)
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    shutil.copyfile(path, target)
            # Low-VRAM mode moves what it can off the GPU between pictures; the text encoder runs on the CPU.
            self.process = subprocess.Popen([sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188", "--lowvram"], cwd=COMFY_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(180):
                try:
                    comfy("/system_stats", timeout=3)
                    break
                except OSError:
                    time.sleep(2)
            else:
                raise RuntimeError("ComfyUI didn't start")
            self.ready.set()
            print("  Pictures: ready.", flush=True)
        except Exception as error:  # noqa: BLE001 - reported in /v1/health and to the app
            self.error = f"{type(error).__name__}: {str(error)[:240]}"
            print(f"  Pictures unavailable: {self.error}", flush=True)

    def generate(self, request):
        if not self.enabled:
            raise LookupError("pictures aren't switched on (--images)")
        if not self.ready.is_set():
            raise RuntimeError(self.error or "the image model is still downloading; try again in a few minutes")
        with GPU.picture():
            started = time.time()
            # Her voice leaves no room on a T4: let it go for the moment. The next message reloads it.
            unload_text_models()
            edit = bool(request["image"])
            asked = request["instruction"] if edit and request["instruction"] else request["prompt"]
            prompt, refined = refine_prompt(asked, self.refiner, edit=edit) if request["refine"] else (asked, False)
            source = None
            if edit:
                source = f"freya-source-{request['seed']}.png"
                with open(os.path.join(COMFY_DIR, "input", source), "wb") as handle:
                    handle.write(base64.b64decode(request["image"]))
            try:
                queued = comfy("/prompt", {"prompt": comfy_workflow(request, prompt, self.steps, source), "client_id": "freya"})
            except urllib.error.HTTPError as error:
                raise RuntimeError(f"ComfyUI refused the workflow: {error.read().decode(errors='replace')[:300]}") from error
            prompt_id = queued.get("prompt_id")
            image = self.wait_for(prompt_id)
            # Free the GPU for her voice again.
            with contextlib.suppress(OSError):
                comfy("/free", {"unload_models": True, "free_memory": True})
            return {
                "image": base64.b64encode(image).decode(), "mime": "image/png", "model": IMAGE_MODEL_NAME,
                "seed": request["seed"], "ms": int((time.time() - started) * 1000), **({"refined": prompt} if refined else {}),
            }

    def wait_for(self, prompt_id, limit_s=900):
        """Polls ComfyUI's history until the picture is saved; raises its own error message if it fails."""
        deadline = time.time() + limit_s
        while time.time() < deadline:
            history = comfy(f"/history/{prompt_id}").get(prompt_id)
            if history:
                status = history.get("status", {})
                if status.get("status_str") == "error":
                    messages = [m for m in status.get("messages", []) if m and m[0] == "execution_error"]
                    detail = messages[0][1].get("exception_message", "") if messages else ""
                    raise RuntimeError(f"ComfyUI failed: {detail[:300]}")
                for output in history.get("outputs", {}).values():
                    for item in output.get("images", []):
                        query = urlencode({"filename": item["filename"], "subfolder": item.get("subfolder", ""), "type": item.get("type", "output")})
                        return comfy(f"/view?{query}", timeout=60)
            time.sleep(2)
        raise RuntimeError("the picture took longer than 15 minutes")


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
        except ValueError as error:
            return self.reply_json(400, {"error": str(error)})
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
    # Two models may be loaded: her voice and the tiny embedding model (kept on the CPU). The
    # memory cache in 8-bit (with flash attention) is what lets a 20B with a 4096 window fit a T4.
    env = dict(os.environ, OLLAMA_HOST="127.0.0.1:11434", OLLAMA_KEEP_ALIVE="-1", OLLAMA_NUM_PARALLEL="1", OLLAMA_MAX_LOADED_MODELS="2",
               OLLAMA_FLASH_ATTENTION="1", OLLAMA_KV_CACHE_TYPE="q8_0")
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


def modelfile(base, ctx, chat_format="model"):
    """No SYSTEM and no MESSAGE lines: the app sends the prompt, and example chats would read as real history."""
    lines = [f"FROM {base}"]
    if chat_format in TEMPLATES:
        template, stops = TEMPLATES[chat_format]
        lines.append(f'TEMPLATE """{template}"""')
        lines += [f'PARAMETER stop "{stop}"' for stop in stops]
    elif base.endswith(".gguf"):
        # A .gguf from FREYA's own training is Qwen3.5 and brings no chat format of its own.
        lines += ["RENDERER qwen3.5", "PARSER qwen3.5"]
    lines += [f"PARAMETER num_ctx {ctx}", "PARAMETER temperature 0.85", "PARAMETER top_p 0.95", "PARAMETER repeat_penalty 1.08"]
    return "\n".join(lines) + "\n"


def create_model(name, base, ctx, chat_format="model"):
    path = f"/tmp/{name}.Modelfile"
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(modelfile(base, ctx, chat_format))
    run(f"ollama create {name} -f {path} > /dev/null")


def default_format(base):
    """Dark Forest's GGUF has no chat template: Alpaca is the format its parent models use."""
    return "alpaca" if "dark-forest" in base.lower() else "model"


def load_fitting(candidates, contexts, chat_format=""):
    """The first model and context that sit entirely on the GPU. Part on the CPU makes replies crawl."""
    for base in candidates:
        if not re.search(r"\.gguf$", base):
            print(f"Downloading {base} (several minutes, once per session)...", flush=True)
            run(f'ollama pull "{base}"')
        for ctx in contexts:
            create_model("freya", base, ctx, chat_format or default_format(base))
            post("/api/generate", {"model": "freya", "prompt": "hi", "stream": False, "keep_alive": -1, "options": {"num_ctx": ctx, "num_predict": 1}})
            share = share_on_gpu("freya")
            print(f"  {base} at context {ctx}: {share:.0%} on the GPU", flush=True)
            if share >= 0.995:
                return base, ctx
    sys.exit("It doesn't fit fully on this GPU, even at the smallest size. In Colab: Runtime > Change runtime type > T4 GPU.")


def self_test():
    """Thinking helped Qwen's replies in testing, so it's on if this model has it."""
    shown = post("/api/show", {"model": "freya"}, timeout=60)
    capabilities = shown.get("capabilities") or []
    can_think = "thinking" in capabilities
    started = time.time()
    reply = post("/api/chat", {
        "model": "freya", "stream": False, "keep_alive": -1, **({"think": True} if can_think else {}),
        "messages": [{"role": "system", "content": "You're texting a friend. Reply in one short line."}, {"role": "user", "content": "why do mirrors flip left and right but not up and down"}],
        "options": {"num_predict": 300},
    })
    seconds = time.time() - started
    speed = reply.get("eval_count", 0) / max(reply.get("eval_duration", 1) / 1e9, 0.001)
    print(f"  Hidden thinking: {'available' if can_think else 'not available'}", flush=True)
    print(f"  Sees images: {'yes' if 'vision' in capabilities else 'no: the helper model reads them for her'}", flush=True)
    print(f"  Speed: {speed:.0f} tokens a second; that reply took {seconds:.0f}s", flush=True)
    print(f"  Sample: {reply.get('message', {}).get('content', '').strip()[:300]}", flush=True)
    return can_think, capabilities


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
    parser.add_argument("--chat-format", default="", choices=["", "alpaca", "chatml", "model"])
    parser.add_argument("--fallback-model", default=DEFAULT_FALLBACK)
    parser.add_argument("--embed-model", default=DEFAULT_EMBED)
    parser.add_argument("--vision-model", default="")
    parser.add_argument("--images", action="store_true")
    parser.add_argument("--image-steps", type=int, default=20)
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

    helper = use(args.fallback_model)
    # The helper (an Ollama library model) refines picture prompts; a .gguf or hf: helper works too once built.
    images = ImageEngine(args.images, hf_token, refiner="freya-helper" if helper else "", steps=max(4, min(50, args.image_steps)))
    if args.images:
        # ComfyUI and ~15 GB of weights download while the text model loads; the GPU isn't touched yet.
        threading.Thread(target=images.prepare, daemon=True).start()

    step("2/5 Ollama")
    install_ollama()

    step("3/5 The model")
    model = args.model
    if model.startswith("hf:"):
        model = from_hugging_face(model, hf_token)
    candidates = [model] if model else next(models for floor, models in MODELS_BY_VRAM if gigabytes >= floor)
    base, ctx = load_fitting(candidates, [args.ctx] if args.ctx else CONTEXTS, args.chat_format)
    models = {"voice": "freya"}

    step("4/5 Test")
    can_think, capabilities = self_test()

    if helper and helper != base:
        # One small model, three jobs: fallback voice, eyes for a voice that can't see, picture prompts.
        models["fallback"] = "freya-fallback"
        if "vision" not in capabilities and not use(args.vision_model):
            models["vision"] = "freya-helper"

        def build(source):
            create_model("freya-fallback", source, 8192)
            create_model("freya-helper", source, 8192)
        pull_in_background(helper, "Helper model (fallback, eyes, picture prompts)", after=build, token=hf_token)
    if use(args.vision_model):
        models["vision"] = use(args.vision_model)
        pull_in_background(models["vision"], "Vision model")
    embed = use(args.embed_model)
    if embed:
        models["embed"] = embed
        pull_in_background(embed, "Memory embeddings")

    step("5/5 Opening it to your laptop")
    # On a full GPU (a T4 with her voice), embeddings run on the CPU so they never evict her.
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
        if images.process:
            images.process.terminate()
        print("\nStopped. The tunnel is closed; her laptop falls back until you start this again.", flush=True)


if __name__ == "__main__":
    main()
