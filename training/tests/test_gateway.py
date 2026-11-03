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
