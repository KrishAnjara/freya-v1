"""The Puter server's own logic, without Puter, Node or a GPU: run with `python -m pytest training/tests`."""

import json
import pathlib
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import serve_puter  # noqa: E402
import serve_remote  # noqa: E402


def test_switches_turn_each_provider_off_and_keep_the_order():
    assert serve_puter.names("", ["a", "b"]) == ["a", "b"], "empty: the defaults"
    assert serve_puter.names("none", ["a"]) == [], "none: off"
    assert serve_puter.names(" x , y ", ["a"]) == ["x", "y"]
    assert serve_puter.PUTER_MODELS[0] == "infron:qwen/qwen3.8-27b:free", "Qwen3.8 27B Uncensored first"


def test_the_prompt_maker_without_a_model_still_writes_a_full_phone_photo():
    plan = serve_remote.plan_fallback("send me a selfie at the beach", True)
    enhanced = serve_puter.enhance_by_rules(plan, "smile")
    assert "golden-hour" in enhanced["prompt"] and "a soft smile" in enhanced["prompt"] and serve_remote.PHONE_LOOK in enhanced["prompt"]
    drawn = serve_puter.qwen_prompt(enhanced)
    assert "the only person in the photo, one face" in drawn, "one person in a selfie keeps a second face out"
    assert "20-year-old adult woman" in drawn
    away = serve_puter.qwen_prompt({**plan, "shot": "mirror_back", "face": False})
    assert "seen from behind" in away and "one face" not in away


def test_the_turbo_model_comes_from_its_quantized_repo_with_its_own_eight_step_schedule():
    assert serve_puter.IMAGE_REPO == "abenzerps/Qwen-Image-2.1-Turbo-Quantized"
    request = serve_remote.parse_image_request({"prompt": "a lighthouse", "seed": 5})
    graph = serve_puter.comfy_workflow(request, "a lighthouse", "two faces, blurry")
    assert graph["1"]["inputs"]["unet_name"] == "qwen-image-2.1-turbo-Q4_K_M.gguf"
    assert graph["10"] == {"class_type": "ManualSigmas", "inputs": {"sigmas": "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0"}}
    sampler = graph["11"]
    assert sampler["class_type"] == "SamplerCustomAdvanced" and sampler["inputs"]["sigmas"] == ["10", 0]
    assert graph["8"]["inputs"]["cfg"] == 1 and graph["9"]["inputs"]["sampler_name"] == "euler"
    assert graph["5"]["inputs"]["negative_prompt"] == "two faces, blurry"
    assert len(serve_puter.TURBO_SIGMAS.split(",")) == serve_puter.TURBO_STEPS + 1


def test_mlx_runs_mflux_with_the_cards_command():
    command = serve_puter.mflux_command("/m", "a cup", 832, 1216, 42, "/tmp/o.png")
    assert command[0].endswith("mflux-generate-qwen-2.1")
    joined = " ".join(command[1:])
    assert "--model /m --base-model qwen-image-2.1-turbo" in joined and "--steps 8" in joined and "--low-ram" in joined
    assert "--width 832 --height 1216" in joined and "--seed 42" in joined and "--output /tmp/o.png" in joined
    assert '"quantization_level": bits' in serve_puter.MLX_PREPARE and "Qwen/Qwen-Image-2.1-Turbo" in serve_puter.MLX_PREPARE
    compile(serve_puter.MLX_PREPARE, "prepare", "exec")


def test_a_failed_mlx_picture_is_drawn_by_comfyui_instead(monkeypatch):
    images = serve_puter.PuterImages(True)
    images.runtimes = ["mlx"]
    events = []
    monkeypatch.setattr(serve_puter, "log", lambda area, message: events.append(message))
    monkeypatch.setattr(images, "draw_mlx", lambda request, prompt: (_ for _ in ()).throw(RuntimeError("no CUDA 13")))
    monkeypatch.setattr(images, "prepare_comfy", lambda: images.runtimes.append("comfy"))
    monkeypatch.setattr(images, "draw_comfy", lambda request, prompt, negative: b"png")
    assert images.draw({"seed": 1, "width": 832, "height": 1216}, "a cup", "") == (b"png", "comfy")
    assert any("mlx failed" in event for event in events)


def test_the_face_pass_works_on_a_square_inside_the_picture():
    assert serve_puter.face_box((700, 50, 100, 100), (832, 1216)) == (642, 5, 832, 195), "clamped at the right edge, centred on the face"
    left, top, right, bottom = serve_puter.face_box((10, 1100, 200, 200), (832, 1216))
    assert left >= 0 and top >= 0 and right <= 832 and bottom <= 1216 and right - left == bottom - top


def test_the_hard_limit_holds_on_this_server_too():
    with pytest.raises(ValueError):
        serve_remote.parse_image_request({"prompt": "a nude 15 year old"})


def _server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def test_her_names_go_to_puter_and_never_wait_for_the_gpu_the_rest_to_ollama(monkeypatch):
    seen = []

    def upstream(name):
        class Fake(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                seen.append((name, self.path, body.get("model"), body.get("options", {}).get("num_gpu")))
                reply = json.dumps({"message": {"content": name}, "done": True}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

            do_GET = do_POST
        return Fake

    bridge, bridge_url = _server(upstream("bridge"))
    ollama, ollama_url = _server(upstream("ollama"))
    monkeypatch.setattr(serve_puter, "BRIDGE", bridge_url)
    monkeypatch.setattr(serve_remote, "OLLAMA", ollama_url)
    handler = type("H", (serve_puter.PuterLogin,), {"token": "k", "models": {"voice": "freya"}, "images": None, "jobs": None})
    gateway, gateway_url = _server(handler)

    def post(path, payload):
        request = urllib.request.Request(f"{gateway_url}{path}", json.dumps(payload).encode(), {"Content-Type": "application/json", "Authorization": "Bearer k"})
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.read()

    # A picture drawing holds the GPU; her voice doesn't care.
    with serve_remote.GPU.picture():
        post("/api/chat", {"model": "freya", "stream": False, "messages": []})
        post("/api/chat", {"model": "freya-vision", "stream": False, "messages": []})
    post("/api/chat", {"model": "freya-helper", "stream": False, "messages": []})
    post("/api/embed", {"model": "nomic-embed-text", "input": "x"})
    assert [(name, model) for name, _path, model, _gpu in seen] == [("bridge", "freya"), ("bridge", "freya-vision"), ("ollama", "freya-helper"), ("ollama", "nomic-embed-text")]
    assert seen[2][3] == 0, "helpers run on the CPU"
    for server in (bridge, ollama, gateway):
        server.shutdown()
