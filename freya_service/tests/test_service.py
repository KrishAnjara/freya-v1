import asyncio
import json
from dataclasses import replace

import httpx
from fastapi.responses import Response
from httpx import ASGITransport

from freya_service.app.config import Settings
from freya_service.app.main import app
from freya_service.app.router import build_providers, classify_task, select_provider


TOKEN = "development-test-token-with-more-than-32-chars"


class SyncASGIClient:
    def __init__(self, application):
        self.application = application

    def request(self, method, url, **kwargs):
        async def send():
            async with httpx.AsyncClient(transport=ASGITransport(app=self.application), base_url="http://testserver") as client:
                return await client.request(method, url, **kwargs)
        return asyncio.run(send())

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)

    def close(self):
        return None


def setup_service(handler, monkeypatch, ollama_url="http://ollama.test"):
    monkeypatch.setenv("FREYA_SERVICE_TOKEN", TOKEN)
    monkeypatch.setenv("AI_PROVIDER", "ollama")
    monkeypatch.setenv("AI_FALLBACK_PROVIDER", "groq")
    monkeypatch.setenv("AI_FALLBACK_ENABLED", "true")
    monkeypatch.setenv("GROQ_API_KEY", "test-only-key")
    settings = replace(Settings.from_env(), ollama_url=ollama_url, groq_key="test-only-key")
    app.state.settings = settings
    app.state.providers = build_providers(settings)
    app.state.semaphore = asyncio.Semaphore(2)
    app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=2)
    return SyncASGIClient(app)


def teardown_service():
    asyncio.run(app.state.http.aclose())


def test_health_reports_provider_status_without_credentials(monkeypatch):
    def handler(request):
        assert request.url.path == "/api/tags"
        return httpx.Response(200, json={"models": [{"name": "llama3.2:1b"}]})
    client = setup_service(handler, monkeypatch)
    try:
        public_health = client.get("/health").json()
        result = client.get("/v1/diagnostics", headers={"Authorization": f"Bearer {TOKEN}"}).json()
        assert result["providers"]["ollama"] == "available"
        assert "test-only-key" not in json.dumps(result)
        assert public_health["service_auth_configured"] is True
        assert client.get("/v1/diagnostics").status_code == 401
    finally:
        client.close()
        teardown_service()


def test_ollama_health_is_graceful_when_local_runtime_is_down(monkeypatch):
    def handler(_request):
        raise httpx.ConnectError("local runtime offline")
    client = setup_service(handler, monkeypatch, ollama_url="http://127.0.0.1:11434")
    try:
        result = client.get("/v1/diagnostics", headers={"Authorization": f"Bearer {TOKEN}"}).json()
        assert result["status"] == "ok"
        assert result["providers"]["ollama"] == "unavailable"
    finally:
        client.close()
        teardown_service()


def test_service_chat_auth_validation_and_provider_identity(monkeypatch):
    received = []
    def handler(request):
        assert request.url.path == "/api/chat"
        received.append(json.loads(request.content.decode()))
        return httpx.Response(200, json={"message": {"content": "Local answer."}})
    client = setup_service(handler, monkeypatch)
    payload = {"system": "You are FREYA. api_key=system-secret-123", "messages": [{"role": "user", "content": "Hello password=message-secret-456"}]}
    try:
        assert client.post("/v1/chat", json=payload).status_code == 401
        response = client.post("/v1/chat", json=payload, headers={"Authorization": f"Bearer {TOKEN}"})
        assert response.status_code == 200
        assert response.json()["provider"] == "ollama"
        assert response.json()["reply"] == "Local answer."
        assert "system-secret-123" not in received[0]["messages"][0]["content"]
        assert "message-secret-456" not in received[0]["messages"][1]["content"]
        invalid = {**payload, "messages": [{"role": "system", "content": "bad"}]}
        assert client.post("/v1/chat", json=invalid, headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 422
    finally:
        client.close()
        teardown_service()


def test_provider_outage_falls_back_and_reports_real_provider(monkeypatch):
    def handler(request):
        if request.url.host == "ollama.test":
            return httpx.Response(503, json={})
        assert request.url.host == "api.groq.com"
        return httpx.Response(200, json={"choices": [{"message": {"content": "Hosted fallback."}}]})
    client = setup_service(handler, monkeypatch)
    try:
        response = client.post("/v1/chat", json={"system": "Be accurate", "messages": [{"role": "user", "content": "Hello"}]}, headers={"Authorization": f"Bearer {TOKEN}"})
        assert response.status_code == 200
        assert response.json()["provider"] == "groq"
        assert response.json()["reply"] == "Hosted fallback."
    finally:
        client.close()
        teardown_service()


def test_privacy_mode_never_uses_hosted_fallback(monkeypatch):
    calls = []
    def handler(request):
        calls.append(request.url.host)
        return httpx.Response(503, json={})
    client = setup_service(handler, monkeypatch, ollama_url="http://127.0.0.1:11434")
    try:
        response = client.post("/v1/chat", json={"system": "Be local", "privacy_mode": True, "messages": [{"role": "user", "content": "Hello"}]}, headers={"Authorization": f"Bearer {TOKEN}"})
        assert response.status_code == 502
        assert calls == ["127.0.0.1"]
    finally:
        client.close()
        teardown_service()


def test_privacy_mode_rejects_non_loopback_ollama_without_connecting(monkeypatch):
    calls = []
    def handler(request):
        calls.append(request.url.host)
        raise AssertionError("remote model must never receive the private prompt")
    client = setup_service(handler, monkeypatch)
    app.state.settings = replace(app.state.settings, ollama_url="https://ollama.example.com")
    try:
        response = client.post("/v1/chat", json={"system": "local", "privacy_mode": True, "messages": [{"role": "user", "content": "private"}]}, headers={"Authorization": f"Bearer {TOKEN}"})
        assert response.status_code == 503
        assert calls == []
    finally:
        client.close()
        teardown_service()


def test_streaming_sends_provider_and_deltas(monkeypatch):
    def handler(request):
        body = b'{"message":{"content":"Hello"},"done":false}\n{"message":{"content":" there"},"done":true}\n'
        return httpx.Response(200, headers={"content-type": "application/x-ndjson"}, content=body)
    client = setup_service(handler, monkeypatch)
    try:
        response = client.post("/v1/chat/stream", json={"system": "Be brief", "messages": [{"role": "user", "content": "Hello"}]}, headers={"Authorization": f"Bearer {TOKEN}"})
        assert response.status_code == 200
        assert "event: provider" in response.text
        assert '"provider": "ollama"' in response.text
        assert '"text": "Hello"' in response.text
        assert "event: done" in response.text
    finally:
        client.close()
        teardown_service()


def test_oversized_payload_is_rejected(monkeypatch):
    def handler(request):
        raise AssertionError("upstream must not be called")
    client = setup_service(handler, monkeypatch)
    try:
        response = client.post("/v1/chat", content=b" " * 70000, headers={"content-type": "application/json", "Authorization": f"Bearer {TOKEN}"})
        assert response.status_code == 413
    finally:
        client.close()
        teardown_service()


def test_optional_provider_absence_and_task_classification(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    settings = Settings.from_env()
    providers = build_providers(replace(settings, gemini_key=""))
    assert "gemini" not in providers
    assert classify_task("Please debug this TypeScript error") == "coding"
    assert classify_task("Remember that my preferred name is Kai") == "memory_operation"
    assert classify_task("Tell me a joke") == "lightweight_conversation"


def test_task_router_selects_reasoning_and_local_summary_roles(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "groq")
    monkeypatch.setenv("AI_FALLBACK_PROVIDER", "ollama")
    settings = replace(Settings.from_env(), gemini_key="gemini-test", groq_key="groq-test")
    providers = build_providers(settings)
    reasoning, _ = select_provider(settings, providers, task="complex_reasoning")
    summary, _ = select_provider(settings, providers, task="summarization")
    local, fallback = select_provider(settings, providers, privacy_mode=True, task="coding")
    assert reasoning.name == "gemini"
    assert summary.name == "ollama"
    assert local.name == "ollama"
    assert fallback is None


def test_missing_primary_credential_uses_available_configured_fallback(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "groq")
    monkeypatch.setenv("AI_FALLBACK_PROVIDER", "gemini")
    settings = replace(Settings.from_env(), groq_key="", gemini_key="gemini-test")
    providers = build_providers(settings)
    primary, _ = select_provider(settings, providers)
    assert primary.name == "gemini"
