"""The Colab gateway's own logic, without a GPU: run with `python -m pytest training/tests`."""

import importlib.util
import json
import pathlib
import threading
import time

import pytest

spec = importlib.util.spec_from_file_location("serve_remote", pathlib.Path(__file__).resolve().parents[1] / "serve_remote.py")
serve_remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve_remote)


def test_a_picture_waits_for_chats_and_chats_wait_for_a_picture():
    turns = serve_remote.GpuTurns()
    order = []

    def picture():
        with turns.picture():
            order.append("picture start")
            time.sleep(0.05)
            order.append("picture end")

    with turns.chat():
        thread = threading.Thread(target=picture)
        thread.start()
        time.sleep(0.05)
        order.append("chat still running")
    thread.join()
    assert order == ["chat still running", "picture start", "picture end"]

    order.clear()
    with turns.picture():
        chatter = threading.Thread(target=lambda: (turns.chat().__enter__(), order.append("chat ran")))
        chatter.start()
        time.sleep(0.05)
        order.append("picture done")
    chatter.join()
    assert order == ["picture done", "chat ran"]


def test_chats_share_the_gpu():
    turns = serve_remote.GpuTurns()
    inside = []
    with turns.chat():
        other = threading.Thread(target=lambda: turns.chat().__enter__() or inside.append(True))
        other.start()
        other.join(timeout=1)
    assert inside == [True]


def test_embeddings_are_sent_to_the_cpu_only_when_the_gpu_is_full():
    body = json.dumps({"model": "nomic-embed-text", "input": ["hi"]}).encode()
    moved = json.loads(serve_remote.prepare_body("/api/embed", body, True))
    assert moved["options"]["num_gpu"] == 0
    assert serve_remote.prepare_body("/api/embed", body, False) == body
    assert serve_remote.prepare_body("/api/chat", body, True) == body
    assert serve_remote.prepare_body("/api/embed", b"not json", True) == b"not json"


def test_picture_requests_are_bounded():
    parsed = serve_remote.parse_image_request({"prompt": "a lighthouse at night", "width": 1000, "height": 3000, "strength": 5})
    assert parsed["width"] == 960 and parsed["height"] == 1216
    assert parsed["strength"] == 0.9
    assert isinstance(parsed["seed"], int)
    assert serve_remote.parse_image_request({"prompt": "same", "seed": 42})["seed"] == 42
    for bad in [{}, {"prompt": "x"}, {"prompt": "ok", "image": "not base64!"}, "not an object"]:
        with pytest.raises(ValueError):
            serve_remote.parse_image_request(bad)


def test_the_second_line_of_the_hard_limit_holds_here_too():
    with pytest.raises(ValueError, match="not something"):
        serve_remote.parse_image_request({"prompt": "nude 15 year old"})
    assert serve_remote.parse_image_request({"prompt": "a 15 year old dog asleep by the fire"})["prompt"]


def test_health_says_what_is_served_and_nothing_secret():
    images = serve_remote.ImageEngine(True)
    payload = serve_remote.health_payload({"voice": "freya", "fallback": "freya-fallback", "embed": "nomic-embed-text"}, images, ["completion", "vision"], time.time() - 5)
    assert payload["models"]["fallback"] == "freya-fallback"
    assert payload["images"] == {"enabled": True, "ready": False}
    assert "vision" in payload["capabilities"]
    assert "token" not in json.dumps(payload).lower()


def test_pictures_report_why_they_cant_be_made():
    with pytest.raises(LookupError):
        serve_remote.ImageEngine(False).generate({})
    engine = serve_remote.ImageEngine(True)
    with pytest.raises(RuntimeError, match="still downloading"):
        engine.generate({})
    engine.error = "OSError: disk full"
    with pytest.raises(RuntimeError, match="disk full"):
        engine.generate({})


def test_the_login_lets_through_only_what_the_app_needs():
    assert ("POST", "/api/embed") in serve_remote.ALLOWED
    assert ("POST", "/v1/images") in serve_remote.ALLOWED
    for path in ("/api/pull", "/api/delete", "/api/create", "/api/generate", "/api/push", "/api/copy"):
        assert ("POST", path) not in serve_remote.ALLOWED


def test_dark_forest_gets_a_chat_template_so_her_persona_reaches_it():
    text = serve_remote.modelfile("hf.co/DavidAU/Dark-Forest-V1-Ultra-Quality-20b-GGUF:Q3_K_L", 4096, serve_remote.default_format("hf.co/DavidAU/Dark-Forest-V1-Ultra-Quality-20b-GGUF:Q3_K_L"))
    assert 'TEMPLATE """' in text and "### Instruction:" in text and '{{- if eq .Role "system" }}' in text
    assert 'PARAMETER stop "### Instruction:"' in text
    assert "PARAMETER num_ctx 4096" in text
    assert "MESSAGE" not in text and "SYSTEM" not in text, "the app sends the prompt; examples would read as real history"
    qwen = serve_remote.modelfile("huihui_ai/qwen3.5-abliterated:4B", 8192)
    assert "TEMPLATE" not in qwen, "a library model keeps its own format"
    assert "RENDERER qwen3.5" in serve_remote.modelfile("/content/drive/freya-trained.gguf", 8192)


def test_the_picture_graph_follows_the_official_qwen_image_workflow():
    request = serve_remote.parse_image_request({"prompt": "a lighthouse", "width": 768, "height": 1024, "seed": 7})
    graph = serve_remote.comfy_workflow(request, "a lighthouse in a storm", 20)
    assert graph["1"]["class_type"] == "UnetLoaderGGUF" and graph["1"]["inputs"]["unet_name"] == "qwen-image-2.1-UC-Q4_K_M.gguf"
    assert graph["3"]["inputs"] == {"clip_name": "qwen3vl_8b_int8_convrot.safetensors", "type": "qwen_image", "device": "default"}
    assert graph["7"]["inputs"]["latent_image"] == ["6", 0] and graph["6"]["inputs"]["width"] == 768
    assert graph["7"]["inputs"]["cfg"] == 1 and graph["7"]["inputs"]["steps"] == 20 and graph["7"]["inputs"]["seed"] == 7
    edit = serve_remote.comfy_workflow(request, "make it night", 20, "freya-source-7.png")
    assert edit["10"]["inputs"]["image"] == "freya-source-7.png"
    assert edit["5"]["inputs"]["images.image_1"] == ["10", 0] and edit["5"]["inputs"]["vae"] == ["4", 0]
    assert edit["7"]["inputs"]["latent_image"] == ["5", 2] and "6" not in edit
    for node in graph.values():
        for value in node["inputs"].values():
            if isinstance(value, list):
                assert value[0] in graph, f"{value} points at a node that isn't there"


def test_the_prompt_refiner_fixes_and_expands_but_cannot_cross_the_line(monkeypatch):
    replies = iter([
        {"message": {"content": "A weathered lighthouse on black rocks, storm waves exploding against it, lightning splitting the sky, cinematic, photorealistic."}},
        {"message": {"content": "REFUSE"}},
        {"message": {"content": "a nude 16 year old"}},
    ])
    monkeypatch.setattr(serve_remote, "post", lambda path, payload, timeout=0: next(replies))
    refined, changed = serve_remote.refine_prompt("a lihgthouse in a strom", "freya-helper")
    assert changed and "lighthouse" in refined
    with pytest.raises(ValueError):
        serve_remote.refine_prompt("something", "freya-helper")
    with pytest.raises(ValueError):
        serve_remote.refine_prompt("something", "freya-helper")
    assert serve_remote.refine_prompt("as is", "") == ("as is", False), "no helper model: the prompt is used as written"


def test_a_refiner_that_is_down_never_stops_the_picture(monkeypatch):
    def down(*args, **kwargs):
        raise OSError("connection refused")
    monkeypatch.setattr(serve_remote, "post", down)
    assert serve_remote.refine_prompt("a red fox", "freya-helper") == ("a red fox", False)
