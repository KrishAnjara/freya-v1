import asyncio
import json
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .api.schemas import ChatPayload, ChatResponse
from .config import Settings
from .providers.base import ChatRequest, Provider
from .router import build_providers, classify_task, select_provider
from .security.auth import require_service_auth
from dotenv import load_dotenv

load_dotenv()

@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings.from_env()
    app.state.settings = settings
    app.state.providers = build_providers(settings)
    app.state.semaphore = asyncio.Semaphore(settings.max_concurrency)
    app.state.http = httpx.AsyncClient(timeout=httpx.Timeout(settings.timeout_seconds, connect=5.0))
    yield
    await app.state.http.aclose()


app = FastAPI(title="FREYA Orchestration Service", version="1.0.0", lifespan=lifespan)


class BodyLimitMiddleware:
    def __init__(self, app, max_bytes: int):
        self.app, self.max_bytes = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") not in {"/v1/chat", "/v1/chat/stream"}:
            await self.app(scope, receive, send)
            return
        length = next((value for key, value in scope.get("headers", []) if key.lower() == b"content-length"), None)
        if length:
            try:
                if int(length) > self.max_bytes:
                    response = JSONResponse({"detail": "Request body too large"}, status_code=413)
                    await response(scope, receive, send)
                    return
            except ValueError:
                response = JSONResponse({"detail": "Invalid content length"}, status_code=400)
                await response(scope, receive, send)
                return
        messages = []
        total = 0
        while True:
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > self.max_bytes:
                    response = JSONResponse({"detail": "Request body too large"}, status_code=413)
                    await response(scope, receive, send)
                    return
                messages.append(message)
                if not message.get("more_body", False):
                    break
        iterator = iter(messages)
        async def replay():
            try:
                return next(iterator)
            except StopIteration:
                return await receive()
        await self.app(scope, replay, send)


app.add_middleware(BodyLimitMiddleware, max_bytes=Settings.from_env().max_body_bytes)


def authorized(request: Request, authorization: str | None = None):
    try:
        require_service_auth(request.app.state.settings, authorization)
    except HTTPException:
        raise


@app.get("/health")
async def health(request: Request):
    return {"status": "ok"}


@app.get("/v1/diagnostics")
async def diagnostics(request: Request, authorization: str | None = Header(default=None)):
    authorized(request, authorization)
    settings: Settings = request.app.state.settings
    providers: dict[str, Provider] = request.app.state.providers
    health = {name: "configured" for name in sorted(providers)}
    if "ollama" in providers:
        try:
            result = await request.app.state.http.get(f"{settings.ollama_url}/api/tags", timeout=1.5)
            if result.is_success:
                names = {item.get("name") for item in result.json().get("models", [])}
                # Ollama lists "freya" as "freya:latest"; an untagged name means :latest.
                wanted = settings.ollama_model if ":" in settings.ollama_model else f"{settings.ollama_model}:latest"
                health["ollama"] = "available" if wanted in names or settings.ollama_model in names else "available_model_missing"
            else:
                health["ollama"] = "unavailable"
        except (httpx.HTTPError, ValueError):
            health["ollama"] = "unavailable"
    return {
        "status": "ok",
        "providers": health,
        "primary_provider": settings.primary_provider,
        "reasoning_provider": settings.reasoning_provider,
        "summary_provider": settings.summary_provider,
        "fallback_enabled": settings.fallback_enabled,
        "max_concurrency": settings.max_concurrency,
        "timeout_seconds": settings.timeout_seconds,
    }


@app.post("/v1/chat", response_model=ChatResponse)
async def chat(payload: ChatPayload, request: Request, authorization: str | None = Header(default=None)):
    authorized(request, authorization)
    settings: Settings = request.app.state.settings
    providers: dict[str, Provider] = request.app.state.providers
    messages = [message.model_dump() for message in payload.messages]
    task = classify_task(messages[-1]["content"])
    try:
        primary, fallback = select_provider(settings, providers, payload.privacy_mode, task, payload.ollama_model is not None)
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Configured provider is unavailable") from None
    chat_request = ChatRequest(system=payload.system, messages=messages, ollama_model=payload.ollama_model)
    async with request.app.state.semaphore:
        try:
            reply = await primary.chat(chat_request, request.app.state.http)
            used = primary.name
        except (httpx.HTTPError, RuntimeError, ValueError):
            if await request.is_disconnected() or fallback is None:
                raise HTTPException(status_code=502, detail="Configured provider request failed") from None
            try:
                reply = await fallback.chat(chat_request, request.app.state.http)
                used = fallback.name
            except (httpx.HTTPError, RuntimeError, ValueError):
                raise HTTPException(status_code=502, detail="Configured providers are unavailable") from None
    return ChatResponse(reply=reply, provider=used, task=task)


@app.post("/v1/chat/stream")
async def stream_chat(payload: ChatPayload, request: Request, authorization: str | None = Header(default=None)):
    authorized(request, authorization)
    settings: Settings = request.app.state.settings
    providers: dict[str, Provider] = request.app.state.providers
    messages = [message.model_dump() for message in payload.messages]
    task = classify_task(messages[-1]["content"])
    try:
        primary, fallback = select_provider(settings, providers, payload.privacy_mode, task, payload.ollama_model is not None)
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Configured provider is unavailable") from None
    chat_request = ChatRequest(system=payload.system, messages=messages, ollama_model=payload.ollama_model)

    async def events():
        async with request.app.state.semaphore:
            emitted = False
            for provider in (primary, fallback):
                if provider is None:
                    break
                try:
                    yield f"event: provider\ndata: {json.dumps({'provider': provider.name, 'task': task})}\n\n"
                    async for delta in provider.stream(chat_request, request.app.state.http):
                        if await request.is_disconnected():
                            return
                        emitted = True
                        yield f"event: delta\ndata: {json.dumps({'text': delta})}\n\n"
                    if emitted:
                        yield "event: done\ndata: {}\n\n"
                        return
                except (httpx.HTTPError, RuntimeError, ValueError):
                    if emitted or provider is fallback or await request.is_disconnected():
                        break
            yield f"event: error\ndata: {json.dumps({'error': 'Configured providers are unavailable'})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
