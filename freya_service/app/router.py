from .config import Settings
from .providers.base import Provider
from .providers.gemini import GeminiProvider
from .providers.ollama import OllamaProvider
from .providers.openai_compatible import GroqProvider
from urllib.parse import urlsplit


def classify_task(text: str) -> str:
    lowered = text.lower()
    if any(word in lowered for word in ("remember that", "forget that", "save to memory", "what do you remember")):
        return "memory_operation"
    if any(word in lowered for word in ("search the web", "latest news", "current price", "today's news")):
        return "search"
    if any(word in lowered for word in ("```", "traceback", "implement", "typescript", "python", "debug")):
        return "coding"
    if any(word in lowered for word in ("summarize", "summary", "tl;dr")):
        return "summarization"
    if len(text) > 1800 or any(word in lowered for word in ("compare the tradeoffs", "derive", "prove that")):
        return "complex_reasoning"
    return "lightweight_conversation"


def build_providers(settings: Settings) -> dict[str, Provider]:
    providers: dict[str, Provider] = {"ollama": OllamaProvider(settings)}
    if settings.groq_key:
        providers["groq"] = GroqProvider(settings.groq_key, settings.groq_model)
    if settings.gemini_key:
        providers["gemini"] = GeminiProvider(settings.gemini_key, settings.gemini_model)
    return providers


def select_provider(settings: Settings, providers: dict[str, Provider], privacy_mode: bool = False, task: str = "lightweight_conversation", force_local_model: bool = False) -> tuple[Provider, Provider | None]:
    if privacy_mode or force_local_model:
        hostname = (urlsplit(settings.ollama_url).hostname or "").lower()
        if hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise RuntimeError("Local-only mode requires loopback Ollama")
        primary_name = "ollama"
    elif task in {"complex_reasoning", "coding"}:
        primary_name = settings.reasoning_provider
    elif task == "summarization":
        primary_name = settings.summary_provider
    else:
        primary_name = settings.primary_provider
    if primary_name not in providers:
        primary_name = settings.primary_provider
    primary = providers.get(primary_name)
    if primary is None:
        if settings.fallback_enabled and not privacy_mode:
            primary = providers.get(settings.fallback_provider)
        if primary is None:
            raise RuntimeError("Configured provider is unavailable")
        primary_name = primary.name
    fallback = None
    if settings.fallback_enabled and not privacy_mode and not force_local_model:
        candidates = [settings.fallback_provider, settings.primary_provider, "ollama", "gemini", "groq"]
        fallback_name = next((name for name in candidates if name != primary.name and name in providers), None)
        fallback = providers.get(fallback_name) if fallback_name else None
    return primary, fallback
