from dataclasses import dataclass
from typing import AsyncIterator, Protocol

import httpx


@dataclass(frozen=True)
class ChatRequest:
    system: str
    messages: list[dict[str, str]]
    ollama_model: str | None = None


class Provider(Protocol):
    name: str

    async def chat(self, request: ChatRequest, client: httpx.AsyncClient) -> str: ...

    async def stream(self, request: ChatRequest, client: httpx.AsyncClient) -> AsyncIterator[str]: ...
