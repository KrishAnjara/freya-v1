"""
FREYA's models on a GPU that isn't your laptop: Google Colab, or any Linux machine with an NVIDIA GPU.

    python training/serve_remote.py

It installs Ollama, downloads her voice (SexyGPT v3 Thinking, a Qwen3.8 27B roleplay fine-tune,
uncensored), checks how much of it fits on the GPU, puts a login in front of it (Ollama has none),
opens a Cloudflare tunnel, tests itself, then prints one line to run on your laptop.
training/freya_server.ipynb is this same file in a notebook. Nothing is sent to your laptop until you
run that line, and your laptop runs no model. Her voice is 16.8 GB: whole on a 20 GB+ GPU (L4, A100);
on a free T4 part of it runs on the CPU, so replies are slower.

Behind the same login and address it also serves:
  - a helper model (Qwen3.5 4B abliterated): her fallback voice when the big one fails inside the
    session, her eyes for images, and the picture prompt maker
  - an embedding model, so her memory can be matched by meaning
  - pictures (--images), two models, one on the GPU at a time: normal pictures with RealVisXL +
    IP-Adapter Face (image-guided: a picture of her takes her face from her portrait photo), spicy
    ones with MOSS-Image + an NSFW uncensored LoRA. If one fails, the other tries, and the log says
    so. On a T4 or L4 nothing loads beside her voice: each picture pauses her voice, loads its model,
    draws and frees the GPU. The prompt maker (the helper model, on this machine) fixes spelling and
    grammar and writes the full prompt first. Pictures run as background jobs (a quick tunnel cuts
    requests after ~100 s); while one draws, chats get a quick "busy" so the app's next voice answers.
    Every request, picture step and model switch is logged (route, status, time; never content).
    Sexual content involving anyone under 18 is refused here, before and after the prompt maker.

  --model NAME           an Ollama model, an hf.co/... name, a .gguf path, or hf:USER/REPO/FILE.gguf
                         (your fine-tune on Hugging Face; private repos use HF_TOKEN)
  --chat-format FORMAT   alpaca | chatml | model (the model's own). Dark Forest (--model) uses alpaca.
  --fallback-model NAME  the helper model (default: Qwen3.5 4B abliterated; "none" to skip)
  --embed-model NAME     for memory (default: nomic-embed-text; "none" to skip)
  --vision-model NAME    what reads images when her voice can't (default: the helper model)
  --images               serve pictures (downloads ~36 GB the first time, in the background)
  --image-steps N        sampling steps per picture (default 28; the model card uses 40)
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
import gc
import hmac
import http.client
import json
import queue
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
#: Her voice: SexyGPT v3 Thinking (a Qwen3.8 27B roleplay fine-tune, uncensored, with hidden
#: thinking). It comes in one size only, Q4_K_M at 16.8 GB: whole on a 20 GB+ GPU (L4, A100); on a
#: free T4 (15 GB) part of it runs on the CPU, which works but makes replies slower.
SEXYGPT = "hf.co/ross-dev/SexyGPT-v3-Thinking-Female-gguf:Q4_K_M"
DEFAULT_VOICE = SEXYGPT
#: The previous default, still available with --model.
DARK_FOREST = "hf.co/DavidAU/Dark-Forest-V1-Ultra-Quality-20b-GGUF"
MODELS_BY_VRAM = [
    (0, [SEXYGPT]),
]
#: Qwen3.8 has a long window; 8192 is plenty for the app's prompt and history, and smaller if memory is short.
VOICE_CONTEXTS = [8192, 6144, 4096]
#: The uncensored Qwen 27B: what writes training conversations (colab_run --make-corpus), and a
#: --model choice for a voice that reasons better and sees images, at the cost of Dark Forest's roleplay.
QWEN_BY_VRAM = [
    (20, ["huihui_ai/Qwen3.8-abliterated:27b-q4_K_M", "huihui_ai/Qwen3.8-abliterated:27b-q3_K"]),
    (0, ["huihui_ai/Qwen3.8-abliterated:27b-q3_K", "huihui_ai/Qwen3.8-abliterated:27b-q2_K"]),
]
QWEN_CONTEXTS = [8192, 6144, 4096]
#: Dark Forest (with --model) is a Llama-2 merge trained for 4096 tokens; longer windows only make it ramble.
CONTEXTS = [4096]


def contexts_for(base):
    return CONTEXTS if "dark-forest" in base.lower() else VOICE_CONTEXTS
DEFAULT_FALLBACK = "huihui_ai/qwen3.5-abliterated:4B"
DEFAULT_EMBED = "nomic-embed-text"
#: Pictures, two models (ImageEngine): normal ones image-guided from her portrait, spicy ones with
#: an NSFW model; if one fails the other tries.
SDXL_MODEL = "SG161222/RealVisXL_V5.0"
SDXL_MODEL_NAME = "RealVisXL 5 + IP-Adapter Face"
IP_ADAPTER_REPO = "h94/IP-Adapter"
IMAGE_MODEL = "Ansh92928219/Moss-image-nsfw-uncensored-lora"
IMAGE_MODEL_NAME = "MOSS-Image + NSFW LoRA"
#: The LoRA's trigger word, for its adult photo style (moss_prompt adds it only for adult content).
MOSS_TRIGGER = "moss_xvstyle"
#: From this much GPU memory the face model stays loaded beside her voice.
IMAGE_KEEP_VRAM_GB = 40
#: From this much (an 80 GB A100) MOSS runs in full precision and stays loaded; below, 4-bit per picture.
IMAGE_FULL_VRAM_GB = 70
#: Her look, from her portrait (app/static/freya.png), so every picture of her is the same woman.
FREYA_LOOK = ("Freya, a 20-year-old adult woman with black hair pulled back loosely with a few strands falling around her face, "
              "pale fair skin, striking grey-green eyes, dark straight eyebrows, high cheekbones, a defined jaw and full lips")
#: Expressions the app may name for her reference photo (lib/expression).
IMAGE_EXPRESSION = re.compile(r"[a-z-]{2,30}")
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


def log(area, message):
    """One line in the Colab output: time, what it's about, what happened. Never a message's content."""
    print(f"[{time.strftime('%H:%M:%S')}] {area:<8} {message}", flush=True)


def run(command, **options):
    result = subprocess.run(command, shell=True, **options)
    if result.returncode != 0:
        sys.exit(f"\nStopped: `{command}` failed (exit {result.returncode}). See the output above.")


# --- sharing one GPU ----------------------------------------------------------------------------


class GpuTurns:
    """One GPU, two kinds of work: any number of chats at once, or one picture on its own.

    While a picture is drawing, or waiting for the chats in progress to finish so it can start, the
    GPU is `busy()`: new chats are turned away at once (the app's next voice answers them) rather
    than left hanging for the minutes a picture takes."""

    def __init__(self):
        self._condition = threading.Condition()
        self._chats = 0
        self._picture = False
        self._waiting = 0

    def busy(self):
        with self._condition:
            return self._picture or self._waiting > 0

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
            self._waiting += 1
            try:
                while self._picture or self._chats:
                    self._condition.wait()
            finally:
                self._waiting -= 1
            self._picture = True
        try:
            yield
        finally:
            with self._condition:
                self._picture = False
                self._condition.notify_all()


GPU = GpuTurns()


def prepare_body(path, body, embed_on_cpu, voice_partial=False, voice="freya"):
    """
    Keeps her voice on the GPU. Embeddings go to the CPU on a full GPU. And when her voice only
    partly fits (a 17 GB voice on a 15 GB T4), every other model (the helper: fallback voice, eyes,
    picture prompts) runs on the CPU too, and lets go of its memory 30 s after use: on the GPU it
    pushed her voice out, and the next reply spent minutes reloading it.
    """
    embed = path == "/api/embed" and embed_on_cpu
    helper = path == "/api/chat" and voice_partial
    if not body or not (embed or helper):
        return body
    try:
        payload = json.loads(body)
    except ValueError:
        return body
    if not isinstance(payload, dict) or (helper and str(payload.get("model", "")).split(":")[0] == voice):
        return body
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    payload["options"] = {**options, "num_gpu": 0}
    if helper:
        payload.setdefault("keep_alive", "30s")
    return json.dumps(payload).encode()


def streams(path, body):
    """An Ollama chat streams unless it asks not to."""
    if path != "/api/chat" or not body:
        return False
    try:
        return json.loads(body).get("stream", True) is not False
    except (ValueError, AttributeError):
        return False


def free_memory():
    """After each reply and picture: Python's garbage, the GPU's cached blocks, and RAM back to the system."""
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:  # noqa: BLE001 - torch may not be installed (pictures off)
        pass
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass


#: A blank line this often while a reply is on its way: a quick tunnel cuts a request that's silent
#: for ~100 s, and loading her voice or reading a long prompt can take longer than that.
HEARTBEAT_S = 10


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
    # The hard limit: on in this image path, whatever else is configured.
    if blocked(prompt) or blocked(instruction):
        raise ValueError("not something I'll draw")
    negative = payload.get("negative_prompt") if isinstance(payload.get("negative_prompt"), str) else ""
    image = payload.get("image")
    if image is not None and (not isinstance(image, str) or len(image) > 8_000_000 or not re.fullmatch(r"[A-Za-z0-9+/]+=*", image)):
        raise ValueError("image must be base64")
    # Her face: one of her portrait photos, for a picture of her.
    reference = payload.get("reference")
    if reference is not None and (not isinstance(reference, str) or len(reference) > 6_000_000 or not re.fullmatch(r"[A-Za-z0-9+/]+=*", reference)):
        raise ValueError("reference must be base64")
    expression = payload.get("expression") if isinstance(payload.get("expression"), str) and IMAGE_EXPRESSION.fullmatch(payload.get("expression")) else ""
    strength = payload.get("strength", 0.6)
    strength = min(0.9, max(0.2, float(strength))) if isinstance(strength, (int, float)) else 0.6
    size = lambda value: min(1216, max(512, int(value) // 64 * 64)) if isinstance(value, (int, float)) else 1024
    seed = payload.get("seed")
    return {
        "prompt": prompt.strip(), "instruction": instruction.strip()[:1200], "negative_prompt": negative.strip()[:600], "image": image,
        "reference": reference, "expression": expression,
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


FACE_REFINER_PROMPT = """You turn a picture request into a complete prompt for an image model that is given a reference photo of Freya (image 1), a 20-year-old adult woman. The picture shows her: the same person.
1. Fix spelling and grammar, and work out what they actually meant.
2. Write one vivid English paragraph (60-140 words) describing the finished picture: the shot (close-up, half-body, full-body, selfie, from across a room...), her pose and what she's doing, her expression, clothing, setting, light, camera and lens, colours, mood. A full-body or wider shot when the request implies it. If they named an expression or a mood, use it; otherwise her expression is: {expression}. Photorealistic unless they asked for a style. Don't describe her face, eyes, hair or skin: the reference photo supplies those. Keep every detail they gave.

Adult content between adults is allowed and you don't soften or censor it. Never make her look or act under 18, never add nudity or sexual content they didn't ask for. If the request does either, reply only: REFUSE.
Reply with the prompt only: no preamble, no quotes, no notes."""

#: Her photos' expression names, as the prompt maker says them.
EXPRESSION_WORDS = {
    "neutral": "relaxed and natural", "smile": "a soft smile", "laugh": "laughing", "playful": "a playful smirk", "affectionate": "warm and affectionate",
    "sultry": "sultry, a slow confident look", "sad": "a little sad", "curious": "curious", "interested": "interested, leaning in", "excited": "excited",
    "confident": "confident", "surprised": "surprised", "tired": "sleepy", "bored": "bored", "annoyed": "unimpressed", "thinking": "thoughtful",
}


def refine_prompt(text, model, edit=False, timeout=120, face=False, expression=""):
    """
    The prompt maker: the local helper model fixes spelling and grammar and writes the full picture
    prompt (for a picture of her, around her reference photo and its expression). Falls back to the
    text as given. A refusal, or anything that crosses the hard limit, stops the picture.
    """
    if not model:
        return text, False
    if edit:
        system = EDIT_REFINER_PROMPT
    elif face:
        system = FACE_REFINER_PROMPT.replace("{expression}", EXPRESSION_WORDS.get(expression, "whatever suits the picture"))
    else:
        system = REFINER_PROMPT
    try:
        reply = post("/api/chat", {
            "model": model, "stream": False, "think": False, "keep_alive": 0,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}],
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


def picture_prompt(prompt, kind):
    """What the edit model reads: keep her face (a picture of her), the change (an edit), or a new picture."""
    if kind == "face":
        return ("Image 1 is a photo of Freya. Keep her identity exactly: the same face, facial features, eyes, skin tone and hair as in image 1, "
                f"as a real photograph of the same woman. {prompt}")
    if kind == "edit":
        return prompt
    return f"Replace the blank grey canvas entirely with this picture: {prompt}"


def decode_picture(data):
    """Base64 → an RGB picture."""
    from io import BytesIO
    from PIL import Image
    return Image.open(BytesIO(base64.b64decode(data))).convert("RGB")


def picture_size(request, kind):
    """A picture of her defaults to portrait (room for a full-body shot); anything else as asked."""
    if kind == "face" and request["width"] == request["height"] == 1024:
        return 896, 1216
    return request["width"], request["height"]


def moss_prompt(prompt, kind, expression=""):
    """
    What MOSS-Image reads. It can't take a reference photo, so a picture of her carries her look in
    words, the same every time (FREYA_LOOK), with the face her mood or the request asks for. The
    LoRA's trigger word goes in only for adult content, where its photo style is meant to apply.
    """
    parts = []
    if SEXUAL.search(prompt):
        parts.append(MOSS_TRIGGER)
    if kind == "face":
        face = EXPRESSION_WORDS.get(expression, "")
        parts.append(f"{FREYA_LOOK}{f', {face}' if face else ''}")
    parts.append(prompt)
    return ", ".join(parts) + ". A photograph, photorealistic, natural skin texture, sharp focus."


def sdxl_prompt(prompt, kind):
    """SDXL reads ~75 tokens: the subject first. Her face comes from the adapter and her photo."""
    lead = "photo of a 20 year old woman, " if kind == "face" else ""
    return f"{lead}{prompt}, photorealistic, natural skin texture, detailed, sharp focus"


def load_module(path, name):
    """Imports the model's own pipeline file (pipeline_moss_image.py) from where it was downloaded."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def gpu_memory():
    """'4.1/14.6 GB used' for the log, or '' without a GPU."""
    try:
        import torch
        free, total = torch.cuda.mem_get_info()
        return f"{(total - free) / 1e9:.1f}/{total / 1e9:.1f} GB used"
    except Exception:  # noqa: BLE001 - only for the log
        return ""


def is_spicy(*texts):
    """Adult content: goes to the NSFW model first (picture_order)."""
    return any(SEXUAL.search(text or "") for text in texts)


def picture_order(spicy):
    """Which model tries first; the other is the fallback if the first fails."""
    return ["moss", "face"] if spicy else ["face", "moss"]


class FaceModel:
    """
    Normal pictures: RealVisXL 5 (photoreal SDXL) with IP-Adapter Face-Plus, which takes her face
    from her portrait photo (image to image), so pictures of her look like her. ~8 GB. Kept on the GPU
    from IMAGE_KEEP_VRAM_GB; below that it loads for each picture, in fp16 with parts on the GPU only
    while they work, and is freed again for her voice.
    """

    name = SDXL_MODEL_NAME
    key = "face"

    def __init__(self, token, steps, keep):
        self.token, self.steps, self.keep = token, steps, keep
        self.pipe = None
        self.downloaded = False

    def download(self):
        from huggingface_hub import snapshot_download
        snapshot_download(SDXL_MODEL, allow_patterns=["*.json", "*.txt", "*fp16.safetensors", "tokenizer*/*"], token=self.token)
        snapshot_download(IP_ADAPTER_REPO, allow_patterns=["sdxl_models/ip-adapter-plus-face_sdxl_vit-h.safetensors", "models/image_encoder/*"], token=self.token)
        self.downloaded = True

    def load(self):
        if self.pipe is not None:
            return
        import torch
        from diffusers import StableDiffusionXLPipeline
        from transformers import CLIPVisionModelWithProjection
        encoder = CLIPVisionModelWithProjection.from_pretrained(IP_ADAPTER_REPO, subfolder="models/image_encoder", torch_dtype=torch.float16, token=self.token)
        pipe = StableDiffusionXLPipeline.from_pretrained(SDXL_MODEL, torch_dtype=torch.float16, variant="fp16", image_encoder=encoder, token=self.token)
        pipe.load_ip_adapter(IP_ADAPTER_REPO, subfolder="sdxl_models", weight_name="ip-adapter-plus-face_sdxl_vit-h.safetensors", token=self.token)
        if self.keep:
            pipe.to("cuda")
        else:
            pipe.enable_model_cpu_offload()
        # Decoding in slices keeps the peak low. Newer diffusers keeps this on the VAE itself; the
        # pipeline method that used to do it ("'StableDiffusionXLPipeline' object has no attribute
        # 'enable_vae_slicing'") is gone.
        if hasattr(pipe.vae, "enable_slicing"):
            pipe.vae.enable_slicing()
        elif hasattr(pipe, "enable_vae_slicing"):
            pipe.enable_vae_slicing()
        pipe.set_progress_bar_config(disable=True)
        self.pipe = pipe

    def draw(self, request, prompt, kind, width, height):
        import torch
        from PIL import Image
        generator = torch.Generator("cpu").manual_seed(request["seed"])
        negative = request["negative_prompt"] or "deformed, blurry, bad anatomy, extra fingers, watermark, text"
        blank = Image.new("RGB", (224, 224), (128, 128, 128))
        if kind == "edit":
            from diffusers import StableDiffusionXLImg2ImgPipeline
            self.pipe.set_ip_adapter_scale(0.0)
            edit = StableDiffusionXLImg2ImgPipeline.from_pipe(self.pipe)
            return edit(prompt=sdxl_prompt(prompt, kind), negative_prompt=negative, image=decode_picture(request["image"]), ip_adapter_image=blank,
                        strength=request["strength"], num_inference_steps=self.steps, guidance_scale=5.0, generator=generator).images[0]
        # Her face from the reference photo; for anything else the adapter is switched off.
        self.pipe.set_ip_adapter_scale(0.7 if kind == "face" else 0.0)
        face = decode_picture(request["reference"]) if kind == "face" else blank
        return self.pipe(prompt=sdxl_prompt(prompt, kind), negative_prompt=negative, ip_adapter_image=face, width=width, height=height,
                         num_inference_steps=self.steps, guidance_scale=5.0, generator=generator).images[0]

    def release(self):
        if not self.keep:
            self.pipe = None


class MossModel:
    """
    Spicy pictures: MOSS-Image (OpenMOSS) with the NSFW uncensored LoRA merged in, through its own
    pipeline file. Text to image, so pictures of her are described (moss_prompt). ~28 GB. Full
    precision and kept on the GPU from IMAGE_FULL_VRAM_GB; below that it loads in 4-bit (~9 GB, all on
    the GPU) for each picture and is freed again.
    """

    name = IMAGE_MODEL_NAME
    key = "moss"

    def __init__(self, token, steps, keep):
        self.token, self.steps, self.keep = token, steps, keep
        self.pipe = None
        self.downloaded = False
        self.root = ""

    def download(self):
        from huggingface_hub import snapshot_download
        folder = snapshot_download(IMAGE_MODEL, allow_patterns=["merged-model/*"], ignore_patterns=["merged-model/assets/*"], token=self.token)
        self.root = os.path.join(folder, "merged-model")
        self.downloaded = True

    def load(self):
        if self.pipe is not None:
            return
        import torch
        from diffusers import AutoencoderKLFlux2
        from transformers import AutoModel, AutoTokenizer
        moss = load_module(os.path.join(self.root, "pipeline_moss_image.py"), "pipeline_moss_image")
        # T4s have no bfloat16; half precision there.
        dtype = torch.bfloat16 if torch.cuda.get_device_capability(0)[0] >= 8 else torch.float16
        transformer_options, encoder_options = {"torch_dtype": dtype}, {"dtype": dtype}
        if not self.keep:
            from diffusers import BitsAndBytesConfig as DiffusersBnb
            from transformers import BitsAndBytesConfig as TransformersBnb
            four_bit = {"load_in_4bit": True, "bnb_4bit_quant_type": "nf4", "bnb_4bit_compute_dtype": dtype}
            transformer_options["quantization_config"] = DiffusersBnb(**four_bit)
            encoder_options["quantization_config"] = TransformersBnb(**four_bit)
            encoder_options["device_map"] = {"": 0}
        transformer = moss.MOSSImageTransformer.from_pretrained(self.root, subfolder="transformer", **transformer_options).eval()
        tokenizer = AutoTokenizer.from_pretrained(self.root, subfolder="tokenizer")
        text_encoder = AutoModel.from_pretrained(self.root, subfolder="text_encoder", **encoder_options).eval()
        vae = AutoencoderKLFlux2.from_pretrained(self.root, subfolder="vae", torch_dtype=torch.float32).eval()
        scheduler = moss.MOSSImageScheduler.from_pretrained(self.root, subfolder="scheduler")
        pipe = moss.MOSSImagePipeline(transformer=transformer, scheduler=scheduler, text_encoder=text_encoder, tokenizer=tokenizer, vae=vae)
        if self.keep:
            pipe.to("cuda")
        else:
            pipe.vae.to("cuda")
            if str(getattr(pipe.transformer, "device", "cuda")) == "cpu":
                pipe.transformer.to("cuda")
        pipe.set_progress_bar_config(disable=True)
        self.pipe = pipe

    def draw(self, request, prompt, kind, width, height):
        import torch
        # A change to the last picture is a new picture from the combined description: words only.
        kind = "new" if kind == "edit" else kind
        return self.pipe(
            moss_prompt(prompt, kind, request["expression"]),
            negative_prompt=request["negative_prompt"] or "",
            width=width // 16 * 16, height=height // 16 * 16,
            num_inference_steps=self.steps, guidance_scale=3.0,
            generator=torch.Generator("cpu").manual_seed(request["seed"]),
        ).images[0]

    def release(self):
        if not self.keep:
            self.pipe = None


class ImageEngine:
    """
    Two picture models, one at a time on the GPU (picture_order):
      - normal pictures: FaceModel (RealVisXL + IP-Adapter Face), image-guided from her portrait;
      - spicy (adult) pictures: MossModel (MOSS-Image + NSFW LoRA).
    If the first fails (out of memory, a load error), the other one tries, and the log says so. Both
    download in the background at startup (the smaller face model first) but nothing loads beside her
    voice on a small GPU: each picture lets her voice go, loads its model, draws, and frees the GPU.
    """

    def __init__(self, enabled, token="", refiner="", steps=28):
        self.enabled = enabled
        self.token = token or None
        self.refiner = refiner
        self.steps = steps
        self.ready = threading.Event()
        self.error = ""
        self.models = {}
        self.whole_on_gpu = False
        self.last_model = ""
        #: How long the drawing itself takes here, learned from each picture (a first guess for a T4).
        self.draw_seconds = 60.0 + 4.0 * steps

    @property
    def model_name(self):
        return self.last_model or SDXL_MODEL_NAME

    @property
    def pipe(self):
        """Whatever is loaded right now (None until a picture needs it)."""
        return next((model.pipe for model in self.models.values() if model.pipe is not None), None)

    def prepare(self):
        try:
            log("pictures", "installing diffusers, transformers, bitsandbytes")
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "diffusers>=0.38", "transformers>=5.3", "accelerate", "peft", "safetensors", "bitsandbytes"], check=True)
            import torch
            vram = torch.cuda.get_device_properties(0).total_memory / 1e9
            self.whole_on_gpu = vram >= IMAGE_FULL_VRAM_GB
            self.models = {
                "face": FaceModel(self.token, self.steps, keep=vram >= IMAGE_KEEP_VRAM_GB),
                "moss": MossModel(self.token, self.steps, keep=self.whole_on_gpu),
            }
            log("pictures", f"GPU {vram:.0f} GB: normal = {SDXL_MODEL_NAME} ({'kept loaded' if self.models['face'].keep else 'loaded per picture'}), "
                f"spicy = {IMAGE_MODEL_NAME} ({'full precision, kept loaded' if self.whole_on_gpu else '4-bit, loaded per picture'})")
            for key, size in (("face", "~8 GB"), ("moss", "~28 GB")):
                model = self.models[key]
                started = time.time()
                log("pictures", f"downloading {model.name} ({size})...")
                try:
                    model.download()
                    log("pictures", f"{model.name} downloaded in {time.time() - started:.0f} s")
                    self.ready.set()
                except Exception as error:  # noqa: BLE001 - the other model can still serve
                    log("pictures", f"{model.name} unavailable: {type(error).__name__}: {str(error)[:200]}")
            if self.whole_on_gpu and self.models["moss"].downloaded:
                log("pictures", f"loading {IMAGE_MODEL_NAME} onto the GPU...")
                self.models["moss"].load()
                log("pictures", f"{IMAGE_MODEL_NAME} loaded · {gpu_memory()}")
            if not self.ready.is_set():
                raise RuntimeError("neither picture model could be downloaded")
            log("pictures", "ready")
        except Exception as error:  # noqa: BLE001 - reported in /v1/health and to the app
            self.error = f"{type(error).__name__}: {str(error)[:240]}"
            log("pictures", f"unavailable: {self.error}")

    def generate(self, request, report=lambda stage: None):
        """Makes one picture. `report(stage)` is called as it moves on (refining the prompt, waiting
        for the GPU, drawing); the job queue turns that into progress for the app."""
        if not self.enabled:
            raise LookupError("pictures aren't switched on (--images)")
        if not self.ready.is_set():
            raise RuntimeError(self.error or "the image model is still downloading; try again in a few minutes")
        from io import BytesIO
        import torch
        # An edit of a picture she already sent; a picture of her (from her portrait); or anything else.
        kind = "edit" if request["image"] else "face" if request["reference"] else "new"
        asked = request["instruction"] if kind == "edit" and request["instruction"] else request["prompt"]
        # The prompt maker runs before the GPU is taken: it needs the helper model, and a refusal stops here.
        report("refining")
        started_refine = time.time()
        prompt, refined = refine_prompt(asked, self.refiner, edit=kind == "edit", face=kind == "face", expression=request["expression"]) if request["refine"] else (asked, False)
        log("picture", f"prompt {'rewritten' if refined else 'as asked'} in {time.time() - started_refine:.0f} s · {kind} · {len(prompt)} chars")
        width, height = picture_size(request, kind)
        order = [key for key in picture_order(is_spicy(asked, prompt)) if self.models.get(key) and self.models[key].downloaded]
        if not order:
            raise RuntimeError("no picture model is downloaded yet; try again in a few minutes")
        report("waiting")
        with GPU.picture():
            report("drawing")
            started = time.time()
            # Her voice doesn't fit beside them on a smaller GPU: let it go; the next message reloads it.
            if not self.whole_on_gpu:
                unload_text_models()
                log("picture", f"her voice paused for the picture · {gpu_memory()}")
            failures = []
            for position, key in enumerate(order):
                model = self.models[key]
                try:
                    loading = time.time()
                    if model.pipe is None:
                        log("picture", f"loading {model.name}...")
                    model.load()
                    log("picture", f"{model.name} ready in {time.time() - loading:.0f} s · {gpu_memory()} · drawing {width}x{height}, {self.steps} steps")
                    drawing = time.time()
                    image = model.draw(request, prompt, kind, width, height)
                    buffer = BytesIO()
                    image.save(buffer, "PNG")
                    seconds = time.time() - drawing
                    log("picture", f"done with {model.name} in {seconds:.0f} s ({buffer.tell() // 1024} KB)")
                    self.last_model = model.name
                    # What a picture really takes here, so the next estimate is closer.
                    self.draw_seconds = 0.6 * self.draw_seconds + 0.4 * (time.time() - started)
                    return {
                        "image": base64.b64encode(buffer.getvalue()).decode(), "mime": "image/png", "model": model.name,
                        "seed": request["seed"], "ms": int((time.time() - started) * 1000), **({"refined": prompt} if refined else {}),
                    }
                except Exception as error:  # noqa: BLE001 - the other model gets a go
                    reason = f"{type(error).__name__}: {str(error)[:200]}"
                    failures.append(f"{model.name}: {reason}")
                    nxt = self.models[order[position + 1]].name if position + 1 < len(order) else ""
                    log("picture", f"{model.name} failed ({reason}){f'; switching to {nxt}' if nxt else ''}")
                finally:
                    model.release()
                    free_memory()
                    log("picture", f"memory freed · {gpu_memory()}")
            raise RuntimeError("; ".join(failures))


class PictureJobs:
    """Pictures as background jobs. A request gets an id at once; the app asks how it's going.

    A picture on a T4 takes minutes, and a Cloudflare quick tunnel cuts any request after about
    100 seconds, so a picture can't be one long request. One picture is made at a time, in order;
    a finished or failed job is kept for half an hour, for the app to collect."""

    STAGES = ("queued", "refining", "waiting", "drawing", "done", "error")
    REFINE_SECONDS = 25.0

    def __init__(self, engine, keep_seconds=1800):
        self.engine = engine
        self.keep_seconds = keep_seconds
        self.jobs = {}
        self.order = []
        self.lock = threading.Lock()
        self.wake = threading.Condition(self.lock)
        threading.Thread(target=self.work, daemon=True).start()

    def submit(self, request):
        job_id = secrets.token_hex(8)
        with self.lock:
            self.forget_old()
            self.jobs[job_id] = {"id": job_id, "request": request, "stage": "queued", "created": time.time(), "stage_at": time.time()}
            self.order.append(job_id)
            ahead = sum(1 for other in self.jobs.values() if other["stage"] not in ("done", "error")) - 1
            self.wake.notify()
        log("picture", f"job {job_id} queued ({ahead} ahead) · {'of her' if request.get('reference') else 'edit' if request.get('image') else 'new'} · expression {request.get('expression') or '-'}")
        return {"job": job_id, "eta_s": int(self.estimate() * (1 + ahead)), "ahead": ahead}

    def estimate(self):
        return self.REFINE_SECONDS + self.engine.draw_seconds

    def status(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return None
            now = time.time()
            stage = job["stage"]
            payload = {"status": stage, "elapsed_s": int(now - job["created"])}
            if stage == "done":
                payload.update(job["result"])
                payload["progress"] = 1.0
            elif stage == "error":
                payload["error"] = job["error"]
            else:
                in_stage = now - job["stage_at"]
                draw = max(30.0, self.engine.draw_seconds)
                # Progress is honest about what it is: an estimate from how long pictures take here.
                progress = {"queued": 0.0, "refining": 0.02 + 0.06 * min(1.0, in_stage / self.REFINE_SECONDS), "waiting": 0.09,
                            "drawing": 0.1 + 0.85 * min(0.98, in_stage / draw)}[stage]
                remaining = {"queued": self.estimate(), "refining": draw + max(0.0, self.REFINE_SECONDS - in_stage), "waiting": draw,
                             "drawing": max(5.0, draw - in_stage)}[stage]
                payload.update({"progress": round(progress, 3), "eta_s": int(remaining)})
            return payload

    def work(self):
        while True:
            with self.lock:
                while not any(self.jobs.get(job_id, {}).get("stage") == "queued" for job_id in self.order):
                    self.wake.wait()
                job_id = next(job_id for job_id in self.order if self.jobs.get(job_id, {}).get("stage") == "queued")
                request = self.jobs[job_id]["request"]

            def report(stage, job_id=job_id):
                with self.lock:
                    if job_id in self.jobs:
                        self.jobs[job_id].update({"stage": stage, "stage_at": time.time()})

            started = time.time()
            log("picture", f"job {job_id} started")
            try:
                result = self.engine.generate(request, report)
                outcome = {"stage": "done", "result": result}
                log("picture", f"job {job_id} done in {time.time() - started:.0f} s with {result.get('model', '?')}")
            except Exception as error:  # noqa: BLE001 - every failure is reported to the app, in words
                outcome = {"stage": "error", "error": str(error)[:300] or type(error).__name__}
                log("picture", f"job {job_id} failed after {time.time() - started:.0f} s: {outcome['error']}")
            with self.lock:
                if job_id in self.jobs:
                    self.jobs[job_id].update({**outcome, "stage_at": time.time(), "request": None})

    def forget_old(self):
        cutoff = time.time() - self.keep_seconds
        for job_id in [job_id for job_id, job in self.jobs.items() if job["stage"] in ("done", "error") and job["stage_at"] < cutoff]:
            del self.jobs[job_id]
            self.order.remove(job_id)


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
    jobs = None
    embed_on_cpu = False
    voice_partial = False
    started_at = time.time()

    def log_message(self, *args):  # The standard log would print requests; they hold the conversation.
        pass

    def send_response(self, code, message=None):
        self._status = code
        super().send_response(code, message)

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

    def reply_json(self, status, payload, headers=None):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
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
        """Handles one request, and logs its route, status and time (never its content)."""
        started = time.time()
        self._status = 0
        try:
            self._forward()
        finally:
            path = urlsplit(self.path).path
            # Polls for a picture come every few seconds, health checks too: only failures are worth a line.
            if not ((path.startswith("/v1/images/") or path == "/v1/health") and self._status == 200):
                log("request", f"{self.command} {path} -> {self._status or 'dropped'} in {time.time() - started:.1f} s")

    def _forward(self):
        supplied = self.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied.encode(), f"Bearer {self.token}".encode()):
            return self.refuse(401, "wrong or missing token")
        path = urlsplit(self.path).path
        job = re.fullmatch(r"/v1/images/([a-f0-9]{16})", path) if self.command == "GET" else None
        if (self.command, path) not in ALLOWED and not job:
            return self.refuse(403, "not allowed through this server")
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            return self.refuse(413, "request too large")
        body = self.rfile.read(length) if length else None
        if path == "/v1/health":
            return self.reply_json(200, health_payload(self.models, self.images, self.capabilities(), self.started_at))
        if job:
            return self.picture_status(job.group(1))
        if path == "/v1/images":
            return self.picture(body)
        if path == "/api/chat" and GPU.busy():
            log("chat", "turned away while a picture draws (the app's next voice answers)")
            # Drawing holds the GPU for minutes: say so at once, so the app's next voice answers
            # instead of the conversation stalling until the picture is done.
            return self.reply_json(503, {"error": "busy drawing a picture"}, {"Retry-After": "60"})
        body = prepare_body(path, body, self.embed_on_cpu, self.voice_partial)
        guard = GPU.chat() if path in ("/api/chat", "/api/embed") else contextlib.nullcontext()
        with guard:
            self.relay(path, body)

    def picture(self, body):
        """Starts a picture and returns its job id at once (202); GET /v1/images/<id> says how it's going."""
        if not self.images or not self.images.enabled or not self.jobs:
            return self.reply_json(404, {"error": "pictures aren't switched on here (--images)"})
        try:
            request = parse_image_request(json.loads(body or b"{}"))
        except ValueError as error:
            return self.reply_json(400, {"error": str(error)})
        if not self.images.ready.is_set():
            return self.reply_json(503, {"error": self.images.error or "the image model is still downloading; try again in a few minutes"})
        return self.reply_json(202, self.jobs.submit(request))

    def picture_status(self, job_id):
        status = self.jobs.status(job_id) if self.jobs else None
        if status is None:
            return self.reply_json(404, {"error": "no such picture (finished ones are kept for 30 minutes)"})
        return self.reply_json(200, status)

    def relay(self, path, body):
        if streams(path, body):
            return self.relay_stream(path, body)
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
            free_memory()

    def relay_stream(self, path, body):
        """
        A streamed chat: the app gets its answer headers at once and a blank line every HEARTBEAT_S
        while nothing else is coming (her voice loading, a long prompt being read), so the tunnel
        never cuts it. Ollama's own lines pass straight through; an Ollama error arrives as an
        {"error": ...} line, which the app reads as a failure and falls back on.
        """
        try:
            model = str(json.loads(body).get("model", "?"))
        except (ValueError, AttributeError):
            model = "?"
        events = queue.Queue()

        def pump():
            target = urlsplit(self.upstream)
            connection = http.client.HTTPConnection(target.hostname, target.port, timeout=900)
            try:
                connection.request(self.command, path, body, {"Content-Type": "application/json"})
                response = connection.getresponse()
                events.put(("status", response.status))
                while True:
                    chunk = response.read1(8192)
                    if not chunk:
                        break
                    events.put(("chunk", chunk))
            except OSError as error:
                events.put(("failed", str(error)))
            finally:
                connection.close()
                events.put(("end", None))

        threading.Thread(target=pump, daemon=True).start()
        started, first, sent, status, failure = time.time(), 0.0, 0, 0, b""
        write = lambda data: (self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n"), self.wfile.flush())
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while True:
                try:
                    kind, value = events.get(timeout=HEARTBEAT_S)
                except queue.Empty:
                    write(b"\n")
                    continue
                if kind == "status":
                    status = value
                elif kind == "chunk" and status >= 400:
                    failure += value
                elif kind == "chunk":
                    first = first or time.time()
                    sent += len(value)
                    write(value)
                elif kind == "failed":
                    write((json.dumps({"error": f"her model's server dropped the reply: {value[:160]}"}) + "\n").encode())
                elif kind == "end":
                    break
            if status >= 400:
                detail = failure.decode(errors="replace")[:200]
                write((json.dumps({"error": f"her model's server answered {status}: {detail}"}) + "\n").encode())
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except OSError:
            # The app went away (a new message interrupted her): Ollama finishes on its own.
            self.close_connection = True
        finally:
            took = time.time() - started
            log("chat", f"{model}: first words after {first - started:.1f} s, done in {took:.1f} s, {sent // 1024} KB" if first
                else f"{model}: no words in {took:.1f} s (status {status or 'none'})")
            free_memory()

    do_GET = forward
    do_POST = forward
    do_PUT = forward
    do_DELETE = forward


def start_login(token, upstream, port, models=None, images=None, embed_on_cpu=False, voice_partial=False):
    jobs = PictureJobs(images) if images and images.enabled else None
    handler = type("Handler", (Login,), {"token": token, "upstream": upstream, "models": models or {"voice": "freya"}, "images": images, "jobs": jobs, "embed_on_cpu": embed_on_cpu, "voice_partial": voice_partial, "started_at": time.time()})
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


def saved_token(state_dir):
    """The same key every run (stopped, restarted or crashed), so the line on your laptop only needs the new address."""
    path = os.path.join(state_dir, "token")
    try:
        with open(path, encoding="utf-8") as handle:
            token = handle.read().strip()
        if len(token) >= 24:
            log("resume", f"using the saved key from {path}")
            return token
    except OSError:
        pass
    token = secrets.token_urlsafe(24)
    try:
        os.makedirs(state_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(token)
        os.chmod(path, 0o600)
        log("resume", f"new key saved to {path} (kept for the next run)")
    except OSError as error:
        log("resume", f"couldn't save the key ({error}); the next run gets a new one")
    return token


def keep_downloads(state_dir):
    """
    Downloads go to the state folder (Google Drive, with the notebook's KEEP_ON_DRIVE) instead of the
    runtime's own disk, which a crash or a new runtime wipes: then the next start skips ~50 GB.
    """
    os.environ["OLLAMA_MODELS"] = os.path.join(state_dir, "ollama")
    os.environ["HF_HOME"] = os.path.join(state_dir, "huggingface")
    for folder in (os.environ["OLLAMA_MODELS"], os.environ["HF_HOME"]):
        os.makedirs(folder, exist_ok=True)
    free = shutil.disk_usage(state_dir).free / 1e9
    log("resume", f"models kept in {state_dir} ({free:.0f} GB free there; her voice and pictures need ~55 GB)")


def install_ollama():
    if shutil.which("ollama") is None:
        if shutil.which("apt-get"):
            run("apt-get update -qq && apt-get install -y -qq zstd pciutils > /dev/null")
        run("curl -fsSL https://ollama.com/install.sh | sh > /dev/null")
    if ollama_ready():
        return
    # Two models may be loaded: her voice and the tiny embedding model (kept on the CPU). The
    # memory cache in 8-bit (with flash attention) is what lets a 20B with a 4096 window fit a T4.
    env = dict(os.environ, OLLAMA_HOST="127.0.0.1:11434", OLLAMA_KEEP_ALIVE="-1", OLLAMA_NUM_PARALLEL="1", OLLAMA_MAX_LOADED_MODELS="3",
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


def load_fitting(candidates, contexts, chat_format="", allow_partial=False):
    """
    The first model and context that sit entirely on the GPU. Part on the CPU makes replies crawl,
    so that's only accepted for the default voice (`allow_partial`), which can't fit a T4 whole:
    then the smallest context, with as much on the GPU as Ollama manages.
    """
    for base in candidates:
        if not re.search(r"\.gguf$", base):
            print(f"Downloading {base} (several minutes, once per session)...", flush=True)
            run(f'ollama pull "{base}"')
        for ctx in contexts or contexts_for(base):
            create_model("freya", base, ctx, chat_format or default_format(base))
            post("/api/generate", {"model": "freya", "prompt": "hi", "stream": False, "keep_alive": -1, "options": {"num_ctx": ctx, "num_predict": 1}})
            share = share_on_gpu("freya")
            print(f"  {base} at context {ctx}: {share:.0%} on the GPU", flush=True)
            if share >= 0.995:
                return base, ctx
        if allow_partial:
            ctx = (contexts or contexts_for(base))[-1]
            create_model("freya", base, ctx, chat_format or default_format(base))
            post("/api/generate", {"model": "freya", "prompt": "hi", "stream": False, "keep_alive": -1, "options": {"num_ctx": ctx, "num_predict": 1}})
            print(f"  Using it {share_on_gpu('freya'):.0%} on the GPU at context {ctx}; the rest runs on the CPU, so replies are slower."
                  " A 20 GB+ GPU (L4 or A100) holds it whole.", flush=True)
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
    parser.add_argument("--image-steps", type=int, default=28)
    parser.add_argument("--ctx", type=int, default=0)
    parser.add_argument("--token", default="")
    parser.add_argument("--no-tunnel", action="store_true")
    parser.add_argument("--proxy-only", action="store_true")
    parser.add_argument("--upstream", default=OLLAMA)
    parser.add_argument("--port", type=int, default=PROXY_PORT)
    parser.add_argument("--state-dir", default=os.environ.get("FREYA_STATE_DIR", "/content/freya-state"))
    parser.add_argument("--cache-on-drive", action="store_true")
    # Colab passes its own arguments to a notebook's kernel; those aren't for this.
    args, _ = parser.parse_known_args()
    token = args.token or saved_token(args.state_dir)
    if args.cache_on_drive:
        keep_downloads(args.state_dir)
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
        # The image model (~58 GB) downloads and loads while the text model loads.
        threading.Thread(target=images.prepare, daemon=True).start()

    step("2/5 Ollama")
    install_ollama()

    step("3/5 The model")
    model = args.model
    if model.startswith("hf:"):
        model = from_hugging_face(model, hf_token)
    candidates = [model] if model else next(models for floor, models in MODELS_BY_VRAM if gigabytes >= floor)
    base, ctx = load_fitting(candidates, [args.ctx] if args.ctx else None, args.chat_format, allow_partial=not model)
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
    share = share_on_gpu("freya")
    voice_partial = share < 0.995
    if voice_partial:
        log("memory", f"her voice is {share:.0%} on the GPU: helper models run on the CPU so they never push it out")
    start_login(token, OLLAMA, args.port, models=models, images=images, embed_on_cpu=gigabytes < 30, voice_partial=voice_partial)
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
