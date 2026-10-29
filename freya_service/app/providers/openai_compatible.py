from collections.abc import AsyncIterator
import json

import httpx

from .base import ChatRequest


class GroqProvider:
    name = "groq"
    endpoint = "https://api.groq.com/openai/v1/chat/completions"

    def __init__(self, key: str, model: str):
        self.key, self.model = key, model

    def _body(self, request: ChatRequest, stream: bool) -> dict:
        return {
            "model": self.model,
            "messages": [{"role": "system", "content": request.system}, *request.messages],
            "temperature": 0.85,
            "max_tokens": 1400,
            "stream": stream,
        }

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}

    async def chat(self, request: ChatRequest, client: httpx.AsyncClient) -> str:
        response = await client.post(self.endpoint, headers=self._headers(), json=self._body(request, False))
        response.raise_for_status()
        text = response.json().get("choices", [{}])[0].get("message", {}).get("content", "")
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError("Empty Groq response")
        return text.strip()

    async def stream(self, request: ChatRequest, client: httpx.AsyncClient) -> AsyncIterator[str]:
        async with client.stream("POST", self.endpoint, headers=self._headers(), json=self._body(request, True)) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    item = json.loads(data)
                    delta = item.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    if delta:
                        yield delta
                except (ValueError, TypeError, IndexError):
                    continue
