"""
FREYA's Puter server for Google Colab: her voice through Puter.js, her pictures on Colab's GPU.

The existing GPU server (serve_remote.py) is left as it is; this one is separate, and reuses its
login, tunnel, picture jobs and logging, so the laptop connects to it the same way:

    start.bat --remote https://<address>.trycloudflare.com --key <key>

  - her voice: Puter.js (puter_bridge.mjs, on Node), Qwen3.8 27B Uncensored first, then the
    fallback models in order; optionally a model on this machine's Ollama last. Chats go to
    Puter's cloud, never to this GPU, so she keeps talking while a picture draws.
  - her eyes (what they send): a Puter model that can see, then optionally Gemma 3 4B here.
  - pictures: Qwen-Image 2.1 uncensored (Q4_K_M, a headless ComfyUI) draws the phone photo; where
    her face shows, SDXL (RealVisXL + IP-Adapter Face) redraws just her face from her real photo
    for her mood, so it is her (positive and negative prompts for both). A picture with a doubled
    face is drawn again once. Every finished picture is kept here with its prompt.
  - the prompt maker: a small uncensored model on the CPU (Ollama, never the GPU) plans the shot
    and expands the request; if it's off or fails, rules do it. Memory embeddings run on the CPU too.

Every provider is a switch (the notebook's form, or the arguments below). Puter's key comes from
the PUTER_AUTH_TOKEN Colab secret (puter.com, Account), never from the notebook.
Sexual content involving anyone under 18 is refused, before and after the prompt maker.

  --puter-models A,B,...   Puter models for her voice, in order ("none": Puter off)
  --vision-models A,B,...  Puter models that read pictures ("none": off)
  --local-voice NAME       a model on this machine's Ollama as her last voice ("none": off)
  --local-vision NAME      a model here that reads pictures, last ("none": off)
  --enhancer NAME          the CPU prompt maker ("none": rules only)
  --embed-model NAME       memory embeddings ("none": off)
  --images                 pictures on
  --no-face-fix            pictures without SDXL's face pass
  --image-steps N          Qwen-Image steps
  --token KEY              the login key (default: the one saved from the last run)
  --state-dir PATH         where the key, kept pictures and (with --cache-on-drive) downloads live
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from io import BytesIO
from urllib.parse import urlencode, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve_remote as base  # noqa: E402 - the login, tunnel, jobs and prompt maker are shared

log = base.log

PUTER_MODELS = [
    "infron:qwen/qwen3.8-27b:free",                        # Qwen3.8 27B Uncensored (free), 256k context
    "infron:qwen/qwen3.8-27b-abliterated",
    "infron:qwen/qwen3.5-27b-bluestar-v3-derestricted",
    "openrouter:cognitivecomputations/dolphin-mistral-24b-venice-edition",
]
PUTER_VISION = ["alibaba:qwen/qwen3-vl-plus", "alibaba:qwen/qwen3.8-27b"]
LOCAL_VISION = "gemma3:4b"
ENHANCER = "huihui_ai/qwen3-abliterated:1.7b"
BRIDGE_PORT = 11500
BRIDGE = f"http://127.0.0.1:{BRIDGE_PORT}"
BRIDGE_DIR = os.environ.get("FREYA_BRIDGE_DIR", "/content/freya-puter")
PUTER_NAMES = {"freya", "freya-fallback", "freya-vision"}

#: Qwen-Image 2.1, uncensored quantisation, and its companions (all in one repository).
IMAGE_REPO = "abenzerps/Qwen-Image-2.1-Uncensored-Quantized"
IMAGE_FILES = {
    "diffusion_models": "qwen-image-2.1-UC-Q4_K_M.gguf",
    "text_encoders": "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
    "vae": "vae/qwen_image_2.1_vae_bf16.safetensors",
}
IMAGE_MODEL_NAME = "Qwen-Image 2.1 uncensored (Q4_K_M)"
FACE_FIX_NAME = "SDXL face (RealVisXL + IP-Adapter Face)"
COMFY_DIR = os.environ.get("FREYA_COMFY_DIR", "/content/ComfyUI")
COMFY = "http://127.0.0.1:8188"
#: What every picture avoids (the app sends its own list; this is for anything else with the key).
NEGATIVE = ("duplicate face, two faces, cloned face, multiple heads, extra people, deformed face, asymmetric eyes, extra limbs, "
            "extra fingers, bad hands, bad anatomy, blurry, low quality, plastic skin, cartoon, illustration, 3d render, text, watermark, logo")
#: How much of her real photo SDXL puts into her face, and how far it may redraw it.
FACE_FIX_SCALE = 0.75
FACE_FIX_STRENGTH = 0.42


# --- the prompt maker (CPU) ---------------------------------------------------------------------

_LIGHT = [
    (re.compile(r"\b(night|bed|late|dark|club|party)\b", re.I), "dim warm lamp light, phone flash glow"),
    (re.compile(r"\b(beach|outside|outdoor|park|street|sun|sunset|walk)\b", re.I), "natural daylight, golden-hour sun"),
    (re.compile(r"\b(shower|bath|bathroom|mirror)\b", re.I), "bathroom vanity light, soft reflections"),
]


def enhance_by_rules(plan, expression=""):
    """The prompt maker without a model: the shot, what they asked, light, her expression, the phone look."""
    prompt = plan["prompt"]
    light = next((words for pattern, words in _LIGHT if pattern.search(prompt)), "soft natural light")
    parts = [prompt, light]
    if plan["face"]:
        parts.append(base.EXPRESSION_WORDS.get(expression, "relaxed and natural"))
    parts.append(base.PHONE_LOOK)
    return {**plan, "prompt": ", ".join(parts)}


def qwen_prompt(plan):
    """What Qwen-Image reads. It draws from words, so a picture of her carries her look; with one
    person in frame it says so, which keeps a second face out."""
    lead = base.PHONE_SHOTS.get(plan["shot"], "a phone photo")
    who = f"{base.FREYA_LOOK}, the only person in the photo, one face. " if plan["face"] else (
        "Freya, a 20-year-old adult woman, seen from behind or out of frame. " if plan["her"] else "")
    return f"{lead}. {who}{plan['prompt']}. {base.PHONE_LOOK}."


def face_prompt(expression):
    return (f"close-up phone photo of the face of a 20 year old woman, {base.EXPRESSION_WORDS.get(expression, 'relaxed and natural')}, "
            "detailed natural skin texture, sharp focus, realistic eyes, same light and colours as the photo")


# --- Qwen-Image through ComfyUI -----------------------------------------------------------------


def comfy_workflow(request, prompt, steps, negative, source_name=None):
    """ComfyUI's API graph for Qwen-Image 2.1, as in Comfy-Org's official templates (t2i and edit)."""
    graph = {
        "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": os.path.basename(IMAGE_FILES["diffusion_models"])}},
        "2": {"class_type": "QwenImage21Cache", "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": os.path.basename(IMAGE_FILES["text_encoders"]), "type": "qwen_image", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": os.path.basename(IMAGE_FILES["vae"])}},
        "5": {"class_type": "TextEncodeQwenImage21", "inputs": {"clip": ["3", 0], "prompt": prompt, "negative_prompt": negative, "resolution": 1024}},
        "7": {"class_type": "KSampler", "inputs": {
            "model": ["2", 0], "positive": ["5", 0], "negative": ["5", 1], "seed": request["seed"], "steps": steps,
            "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1,
        }},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["4", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "freya"}},
    }
    if source_name:
        # A change to a picture she sent: it goes into the encoder, which also gives the latent at its size.
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


def faces_in(image):
    """Faces in a picture, largest first, as (x, y, w, h). OpenCV's own detector: no download, CPU."""
    import cv2
    import numpy as np
    gray = cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2GRAY)
    detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    size = max(40, min(image.size) // 14)
    found = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(size, size))
    return sorted((tuple(int(value) for value in face) for face in found), key=lambda face: face[2] * face[3], reverse=True)


def face_box(face, size):
    """A square around a face, with room for hair and chin, inside the picture."""
    x, y, w, h = face
    side = min(int(max(w, h) * 1.9), *size)
    left = min(max(0, x + w // 2 - side // 2), size[0] - side)
    top = min(max(0, y + h // 2 - side // 2), size[1] - side)
    return left, top, left + side, top + side


class PuterImages:
    """
    Qwen-Image 2.1 draws, then SDXL redraws her face from her real photo. One at a time on the GPU,
    both set up in the background at start; each is let go of after every picture.
    """

    def __init__(self, enabled, token="", enhancer="", steps=20, face_fix=True):
        self.enabled = enabled
        self.token = token or None
        self.enhancer = enhancer
        self.steps = steps
        self.face_fix = face_fix
        self.ready = threading.Event()
        self.error = ""
        self.process = None
        self.face = None
        self.save_dir = ""
        self.draw_seconds = 120.0 + 6.0 * steps

    @property
    def model_name(self):
        return IMAGE_MODEL_NAME

    def prepare(self):
        """Installs ComfyUI with the GGUF loader, downloads Qwen-Image's three files and SDXL's, starts ComfyUI."""
        try:
            if not os.path.isdir(COMFY_DIR):
                subprocess.run(["git", "clone", "-q", "--depth", "1", "https://github.com/comfyanonymous/ComfyUI", COMFY_DIR], check=True)
            nodes = os.path.join(COMFY_DIR, "custom_nodes", "ComfyUI-GGUF")
            if not os.path.isdir(nodes):
                # The fork with Qwen-Image 2.1 support, as the model's card says.
                subprocess.run(["git", "clone", "-q", "--depth", "1", "https://github.com/leejet/ComfyUI-GGUF", nodes], check=True)
            log("pictures", "installing ComfyUI's requirements, diffusers, OpenCV")
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", os.path.join(COMFY_DIR, "requirements.txt"), "-r", os.path.join(nodes, "requirements.txt"),
                            "diffusers>=0.38", "transformers", "accelerate", "safetensors", "opencv-python-headless"], check=True)
            from huggingface_hub import hf_hub_download
            for folder, name in IMAGE_FILES.items():
                target = os.path.join(COMFY_DIR, "models", folder, os.path.basename(name))
                if not os.path.exists(target):
                    started = time.time()
                    log("pictures", f"downloading {os.path.basename(name)}...")
                    path = hf_hub_download(IMAGE_REPO, name, token=self.token)
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    shutil.copyfile(path, target)
                    log("pictures", f"{os.path.basename(name)} in {time.time() - started:.0f} s")
            # Low-VRAM mode keeps only what's drawing on the GPU.
            self.process = subprocess.Popen([sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188", "--lowvram"], cwd=COMFY_DIR,
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(180):
                try:
                    comfy("/system_stats", timeout=3)
                    break
                except OSError:
                    time.sleep(2)
            else:
                raise RuntimeError("ComfyUI didn't start")
            log("pictures", f"{IMAGE_MODEL_NAME} ready")
            if self.face_fix:
                try:
                    face = base.FaceModel(self.token, max(20, self.steps), keep=False)
                    log("pictures", f"downloading {FACE_FIX_NAME} (~8 GB)...")
                    face.download()
                    self.face = face
                    log("pictures", f"{FACE_FIX_NAME} ready")
                except Exception as error:  # noqa: BLE001 - pictures still work, without the face pass
                    log("pictures", f"{FACE_FIX_NAME} unavailable ({type(error).__name__}: {str(error)[:160]}); pictures go without it")
            self.ready.set()
        except Exception as error:  # noqa: BLE001 - reported in /v1/health and to the app
            self.error = f"{type(error).__name__}: {str(error)[:240]}"
            log("pictures", f"unavailable: {self.error}")

    def plan(self, request):
        """The CPU prompt maker: what kind of phone photo, whether she's in it and her face shows, the full prompt."""
        asked = request["prompt"]
        plan = base.plan_picture(asked, self.enhancer if request["refine"] else "", request["expression"], has_reference=bool(request["reference"]))
        if not plan["refined"]:
            plan = enhance_by_rules(plan, request["expression"])
        return plan

    def draw(self, request, prompt, negative, source=None):
        try:
            queued = comfy("/prompt", {"prompt": comfy_workflow(request, prompt, self.steps, negative, source), "client_id": "freya"})
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"ComfyUI refused the workflow: {error.read().decode(errors='replace')[:300]}") from error
        return self.wait_for(queued.get("prompt_id"))

    def wait_for(self, prompt_id, limit_s=900):
        """Polls ComfyUI until the picture is saved; raises its own error message if it fails."""
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

    def fix_face(self, png, reference, expression, negative, seed):
        """SDXL redraws her face (only her face) from her real photo, and it's blended back in."""
        import torch
        from diffusers import StableDiffusionXLImg2ImgPipeline
        from PIL import Image, ImageDraw, ImageFilter
        image = Image.open(BytesIO(png)).convert("RGB")
        faces = faces_in(image)
        if not faces:
            log("picture", "no face found for the face pass; kept as drawn")
            return png
        box = face_box(faces[0], image.size)
        crop = image.crop(box)
        self.face.load()
        try:
            self.face.pipe.set_ip_adapter_scale(FACE_FIX_SCALE)
            refine = StableDiffusionXLImg2ImgPipeline.from_pipe(self.face.pipe)
            redrawn = refine(prompt=face_prompt(expression), negative_prompt=negative, image=crop.resize((1024, 1024), Image.LANCZOS),
                             ip_adapter_image=base.decode_picture(reference), strength=FACE_FIX_STRENGTH, num_inference_steps=max(20, self.steps),
                             guidance_scale=5.0, generator=torch.Generator("cpu").manual_seed(seed)).images[0]
        finally:
            self.face.release()
        redrawn = redrawn.resize(crop.size, Image.LANCZOS)
        # A soft oval: the new face fades into the picture, with no visible square.
        mask = Image.new("L", crop.size, 0)
        inset = crop.size[0] // 9
        ImageDraw.Draw(mask).ellipse((inset, inset, crop.size[0] - inset, crop.size[1] - inset), fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(crop.size[0] // 14))
        image.paste(redrawn, box[:2], mask)
        out = BytesIO()
        image.save(out, "PNG")
        return out.getvalue()

    def generate(self, request, report=lambda stage: None):
        if not self.enabled:
            raise LookupError("pictures aren't switched on (--images)")
        if not self.ready.is_set():
            raise RuntimeError(self.error or "the image model is still downloading; try again in a few minutes")
        from PIL import Image
        report("refining")
        started_plan = time.time()
        negative = request["negative_prompt"] or NEGATIVE
        source = None
        if request["image"]:
            asked = request["instruction"] or request["prompt"]
            prompt, refined = base.refine_prompt(asked, self.enhancer, edit=True) if request["refine"] else (asked, False)
            plan = {"shot": "edit", "her": False, "face": False, "prompt": prompt, "refined": refined}
            drawn_prompt = prompt
        else:
            asked = request["prompt"]
            plan = self.plan(request)
            drawn_prompt = qwen_prompt(plan)
        log("picture", f"planned in {time.time() - started_plan:.0f} s ({'prompt maker' if plan['refined'] else 'rules'}): {plan['shot']} · "
            f"{'her face (real photo, ' + (request['expression'] or 'neutral') + ')' if plan['face'] else 'her, no face' if plan['her'] else 'not her'} · {len(drawn_prompt)} chars")
        # The hard limit, once more on exactly what will be drawn.
        if base.blocked(drawn_prompt):
            raise ValueError("not something I'll draw")
        width, height = (832, 1216) if request["width"] == request["height"] == 1024 else (request["width"], request["height"])
        request = {**request, "width": width, "height": height}
        report("waiting")
        with base.GPU.picture():
            report("drawing")
            started = time.time()
            try:
                if request["image"]:
                    source = f"freya-source-{request['seed']}.png"
                    with open(os.path.join(COMFY_DIR, "input", source), "wb") as handle:
                        handle.write(base64.b64decode(request["image"]))
                png = self.draw(request, drawn_prompt, negative, source)
                log("picture", f"{IMAGE_MODEL_NAME} drew it in {time.time() - started:.0f} s")
                # One person in a selfie: a second face is the model's mistake, so it draws again once.
                if plan["shot"] == "selfie" and len(faces_in(Image.open(BytesIO(png)))) > 1:
                    log("picture", "two faces in a selfie; drawing it again with a new seed")
                    request = {**request, "seed": (request["seed"] + 7919) % 2**31}
                    png = self.draw(request, drawn_prompt, negative, source)
            finally:
                with contextlib.suppress(OSError):
                    comfy("/free", {"unload_models": True, "free_memory": True})
            model = IMAGE_MODEL_NAME
            if plan["face"] and request["reference"] and self.face:
                try:
                    fixing = time.time()
                    png = self.fix_face(png, request["reference"], request["expression"], negative, request["seed"])
                    model = f"{IMAGE_MODEL_NAME} + {FACE_FIX_NAME}"
                    log("picture", f"face redrawn from her photo in {time.time() - fixing:.0f} s · {base.gpu_memory()}")
                except Exception as error:  # noqa: BLE001 - the drawn picture still goes out
                    log("picture", f"face pass failed ({type(error).__name__}: {str(error)[:160]}); sending it as drawn")
                finally:
                    base.free_memory()
            seconds = time.time() - started
            self.draw_seconds = 0.6 * self.draw_seconds + 0.4 * seconds
        kept = base.save_picture(self.save_dir, png, {
            "asked": asked, "prompt": drawn_prompt, "negative_prompt": negative, "model": model, "seed": request["seed"],
            "expression": request["expression"], "shot": plan["shot"], "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        })
        if kept:
            log("picture", f"kept as pictures/{kept}.png (+ .json with the prompt)")
        return {"image": base64.b64encode(png).decode(), "mime": "image/png", "model": model, "seed": request["seed"],
                "ms": int(seconds * 1000), **({"refined": drawn_prompt} if plan["refined"] else {})}


# --- the login: Puter names to the bridge, the rest to Ollama -----------------------------------


def model_of(body):
    try:
        return str(json.loads(body or b"{}").get("model", ""))
    except (ValueError, AttributeError):
        return ""


def bridge_state():
    try:
        with urllib.request.urlopen(f"{BRIDGE}/bridge", timeout=3) as response:
            state = json.loads(response.read())
        return {key: state.get(key) for key in ("signedIn", "voices", "eyes", "lastAnswer", "lastFailure", "local")}
    except (OSError, ValueError):
        return {"signedIn": False, "error": "the Puter bridge isn't answering"}


class PuterLogin(base.Login):
    """The same login as the GPU server. Her names (freya, freya-fallback, freya-vision) go to the
    Puter bridge and never wait for the GPU; helpers and embeddings go to Ollama, on the CPU."""

    upstream = BRIDGE

    def _forward(self):
        supplied = self.headers.get("Authorization", "")
        if not base.hmac.compare_digest(supplied.encode(), f"Bearer {self.token}".encode()):
            return self.refuse(401, "wrong or missing token")
        path = urlsplit(self.path).path
        job = re.fullmatch(r"/v1/images/([a-f0-9]{16})", path) if self.command == "GET" else None
        if (self.command, path) not in base.ALLOWED and not job:
            return self.refuse(403, "not allowed through this server")
        length = int(self.headers.get("Content-Length") or 0)
        if length > base.MAX_BODY_BYTES:
            return self.refuse(413, "request too large")
        body = self.rfile.read(length) if length else None
        if path == "/v1/health":
            payload = base.health_payload(self.models, self.images, self.capabilities(), self.started_at)
            return self.reply_json(200, {**payload, "puter": bridge_state()})
        if job:
            return self.picture_status(job.group(1))
        if path == "/v1/images":
            return self.picture(body)
        if path == "/api/tags" or (path in ("/api/chat", "/api/show") and model_of(body) in PUTER_NAMES):
            self.upstream = BRIDGE
            return self.relay(path, body)
        self.upstream = base.OLLAMA
        return self.relay(path, base.prepare_body(path, body, True, True))


# --- setting up ---------------------------------------------------------------------------------


def puter_token():
    token = os.environ.get("PUTER_AUTH_TOKEN", "").strip()
    if not token:
        with contextlib.suppress(Exception):
            from google.colab import userdata
            token = (userdata.get("PUTER_AUTH_TOKEN") or "").strip()
    return token


def node_major():
    try:
        return int(subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip().lstrip("v").split(".")[0])
    except (OSError, ValueError):
        return 0


def start_bridge(token, voices, eyes, local_voice, local_vision):
    """Node 24 and Puter.js (once), then the bridge, logging to this output."""
    if node_major() < 24:
        log("puter", "installing Node 24...")
        base.run("curl -fsSL https://deb.nodesource.com/setup_24.x | bash - > /dev/null && apt-get install -y -qq nodejs > /dev/null")
    os.makedirs(BRIDGE_DIR, exist_ok=True)
    if not os.path.isdir(os.path.join(BRIDGE_DIR, "node_modules", "@heyputer", "puter.js")):
        log("puter", "installing Puter.js...")
        base.run(f"cd {BRIDGE_DIR} && npm init -y > /dev/null && npm install --silent @heyputer/puter.js")
    shutil.copyfile(os.path.join(os.path.dirname(os.path.abspath(__file__)), "puter_bridge.mjs"), os.path.join(BRIDGE_DIR, "puter_bridge.mjs"))
    env = dict(os.environ, PUTER_AUTH_TOKEN=token, FREYA_BRIDGE_PORT=str(BRIDGE_PORT), OLLAMA_URL=base.OLLAMA,
               FREYA_PUTER_MODELS=json.dumps(voices), FREYA_PUTER_VISION=json.dumps(eyes),
               FREYA_LOCAL_VOICE=local_voice, FREYA_LOCAL_VISION=local_vision)
    process = subprocess.Popen(["node", os.path.join(BRIDGE_DIR, "puter_bridge.mjs")], cwd=BRIDGE_DIR, env=env)
    for _ in range(60):
        with contextlib.suppress(OSError):
            urllib.request.urlopen(f"{BRIDGE}/api/version", timeout=2)
            return process
        time.sleep(1)
    sys.exit("The Puter bridge didn't start. See its output above.")


def start_cpu_ollama():
    """Ollama for the helpers (prompt maker, embeddings, local fallbacks), kept off the GPU entirely."""
    if shutil.which("ollama") is None:
        if shutil.which("apt-get"):
            base.run("apt-get update -qq && apt-get install -y -qq zstd pciutils > /dev/null")
        base.run("curl -fsSL https://ollama.com/install.sh | sh > /dev/null")
    if base.ollama_ready():
        return
    env = dict(os.environ, OLLAMA_HOST="127.0.0.1:11434", OLLAMA_KEEP_ALIVE="5m", OLLAMA_NUM_PARALLEL="1", OLLAMA_MAX_LOADED_MODELS="3", CUDA_VISIBLE_DEVICES="-1")
    subprocess.Popen(["ollama", "serve"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if base.ollama_ready():
            return
        time.sleep(1)
    sys.exit("Ollama didn't start.")


def test_voice():
    """One short reply through the bridge: which Puter model answered, or why none did."""
    request = urllib.request.Request(f"{BRIDGE}/api/chat", json.dumps({
        "model": "freya", "stream": False, "messages": [{"role": "user", "content": "Say hi in three words."}], "options": {"num_predict": 20},
    }).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            json.loads(response.read())
        return True, bridge_state().get("lastAnswer") or "?"
    except urllib.error.HTTPError as error:
        return False, error.read().decode(errors="replace")[:300]
    except OSError as error:
        return False, str(error)


def names(value, default):
    value = (value or "").strip()
    if value.lower() in ("none", "off"):
        return []
    return [name.strip() for name in value.split(",") if name.strip()] if value else list(default)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--puter-models", default="")
    parser.add_argument("--vision-models", default="")
    parser.add_argument("--local-voice", default="none")
    parser.add_argument("--local-vision", default=LOCAL_VISION)
    parser.add_argument("--enhancer", default=ENHANCER)
    parser.add_argument("--embed-model", default=base.DEFAULT_EMBED)
    parser.add_argument("--images", action="store_true")
    parser.add_argument("--no-face-fix", action="store_true")
    parser.add_argument("--image-steps", type=int, default=20)
    parser.add_argument("--token", default="")
    parser.add_argument("--no-tunnel", action="store_true")
    parser.add_argument("--port", type=int, default=base.PROXY_PORT)
    parser.add_argument("--state-dir", default=os.environ.get("FREYA_STATE_DIR", "/content/freya-state"))
    parser.add_argument("--cache-on-drive", action="store_true")
    args, _ = parser.parse_known_args()
    use = lambda name: "" if (name or "").strip().lower() in ("", "none", "off") else name.strip()
    voices, eyes = names(args.puter_models, PUTER_MODELS), names(args.vision_models, PUTER_VISION)
    local_voice, local_vision, enhancer, embed = use(args.local_voice), use(args.local_vision), use(args.enhancer), use(args.embed_model)
    if not voices and not local_voice:
        sys.exit("Every voice is switched off: turn on Puter (PUTER_MODELS) or a local voice.")
    token = args.token or base.saved_token(args.state_dir)
    if args.cache_on_drive:
        base.keep_downloads(args.state_dir)
    hf_token = os.environ.get("HF_TOKEN", "")

    base.step("1/5 Puter (her voice)")
    puter = puter_token()
    if voices or eyes:
        if not puter:
            sys.exit("Add your Puter key as the Colab secret PUTER_AUTH_TOKEN (key icon on the left; the key is on puter.com under Account), then run this again.")
    bridge = start_bridge(puter, voices, eyes, local_voice, local_vision)
    for _ in range(20):
        if bridge_state().get("signedIn"):
            break
        time.sleep(1)
    else:
        log("puter", "Puter didn't accept the key (PUTER_AUTH_TOKEN): only local models will answer" if local_voice else "Puter didn't accept the key (PUTER_AUTH_TOKEN)")

    images = PuterImages(args.images, hf_token, enhancer=enhancer, steps=max(4, min(50, args.image_steps)), face_fix=not args.no_face_fix)
    images.save_dir = os.path.join(args.state_dir, "pictures")
    if args.images:
        if not base.gpu_gigabytes():
            log("pictures", "no GPU here: pictures are off (Runtime > Change runtime type > a GPU)")
            images.enabled = False
        else:
            threading.Thread(target=images.prepare, daemon=True).start()

    base.step("2/5 Ollama, on the CPU (prompt maker, memory, local fallbacks)")
    start_cpu_ollama()
    models = {"voice": "freya", **({"fallback": "freya-fallback"} if len(voices) > 1 or local_voice else {}), **({"vision": "freya-vision"} if eyes or local_vision else {})}
    for name, label in ((enhancer, "Prompt maker (CPU)"), (local_voice, "Local voice (CPU)"), (local_vision, "Local eyes (CPU)")):
        if name:
            base.pull_in_background(name, label)
    if embed:
        models["embed"] = embed
        base.pull_in_background(embed, "Memory embeddings")

    base.step("3/5 Pictures")
    print(f"  {'Qwen-Image 2.1 uncensored' + (' + SDXL face pass' if not args.no_face_fix else '') + ', downloading in the background (~30 GB)' if images.enabled else 'off'}", flush=True)

    base.step("4/5 Test")
    ok, detail = test_voice()
    print(f"  {'her voice answers: ' + detail if ok else 'no voice answered yet: ' + detail}", flush=True)

    base.step("5/5 Opening it to your laptop")
    jobs = base.PictureJobs(images) if images.enabled else None
    handler = type("Handler", (PuterLogin,), {"token": token, "models": models, "images": images, "jobs": jobs, "started_at": time.time()})
    server = base.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url, tunnel = f"http://THIS-SERVER:{args.port}", None
    if not args.no_tunnel:
        tunnel, url = base.open_tunnel(args.port)
    line = f"start.bat --remote {url} --key {token} --ctx 16384"
    print(f"""
================================================================================
 FREYA's voice is up through Puter: {' > '.join(voices) or 'off'}{' > local ' + local_voice if local_voice else ''}
 Eyes: {' > '.join(eyes) or 'off'}{' > local ' + local_vision if local_vision else ''} · pictures: {'on' if images.enabled else 'off'}

 On your laptop, in the freya-v1 folder, run:

     {line}

 Keep this running. To stop: interrupt this cell.
================================================================================
""", flush=True)

    try:
        while True:
            time.sleep(30)
            if bridge.poll() is not None:
                log("puter", "the bridge stopped; starting it again")
                bridge = start_bridge(puter, voices, eyes, local_voice, local_vision)
            if tunnel and tunnel.poll() is not None:
                tunnel, url = base.open_tunnel(args.port)
                print(f"\nThe tunnel dropped and came back at a new address. On your laptop run:\n\n    start.bat --remote {url} --key {token} --ctx 16384\n", flush=True)
    except KeyboardInterrupt:
        for process in (tunnel, bridge, images.process):
            if process:
                process.terminate()
        print("\nStopped.", flush=True)


if __name__ == "__main__":
    main()
