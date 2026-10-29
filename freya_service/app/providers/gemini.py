from collections.abc import AsyncIterator
import json

import httpx

from .base import ChatRequest


class GeminiProvider:
    name = "gemini"

    def __init__(self, key: str, model: str):
        self.key, self.model = key, model

    def _url(self, method: str, query: str = "") -> str:
        suffix = f"&{query}" if query else ""
        return f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:{method}?key={self.key}{suffix}"

    def _body(self, request: ChatRequest) -> dict:
        return {
            "systemInstruction": {"parts": [{"text": request.system}]},
            "contents": [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]} for m in request.messages],
            "generationConfig": {"temperature": 0.85, "maxOutputTokens": 1400},
        }

    async def chat(self, request: ChatRequest, client: httpx.AsyncClient) -> str:
        response = await client.post(self._url("generateContent"), json=self._body(request))
        response.raise_for_status()
        parts = response.json().get("candidates", [{}])[0].get("content", {}).get("parts", [])
        text = "".join(part.get("text", "") for part in parts)
        if not text.strip():
            raise RuntimeError("Empty Gemini response")
        return text.strip()

    async def stream(self, request: ChatRequest, client: httpx.AsyncClient) -> AsyncIterator[str]:
        async with client.stream("POST", self._url("streamGenerateContent", "alt=sse"), json=self._body(request)) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    item = json.loads(line[5:].strip())
                    parts = item.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                    text = "".join(part.get("text", "") for part in parts)
                    if text:
                        yield text
                except (ValueError, TypeError, IndexError):
                    continue
