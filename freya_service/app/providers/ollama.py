import json
from collections.abc import AsyncIterator

import httpx

from .base import ChatRequest
from ..config import Settings


class OllamaProvider:
    name = "ollama"

    def __init__(self, settings: Settings):
        self.settings = settings

    def _body(self, request: ChatRequest, stream: bool) -> dict:
        return {
            "model": request.ollama_model or self.settings.ollama_model,
            "stream": stream,
            "messages": [{"role": "system", "content": request.system}, *request.messages],
            "options": {"num_ctx": self.settings.ollama_context, "num_predict": 1400},
        }

    async def chat(self, request: ChatRequest, client: httpx.AsyncClient) -> str:
        response = await client.post(f"{self.settings.ollama_url}/api/chat", json=self._body(request, False))
        response.raise_for_status()
        text = response.json().get("message", {}).get("content", "")
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError("Empty Ollama response")
        return text.strip()

    async def stream(self, request: ChatRequest, client: httpx.AsyncClient) -> AsyncIterator[str]:
        async with client.stream("POST", f"{self.settings.ollama_url}/api/chat", json=self._body(request, True)) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line:
                    continue
                item = json.loads(line)
                text = item.get("message", {}).get("content", "")
                if text:
                    yield text
