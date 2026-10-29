from dataclasses import dataclass
import os


def _bounded_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return min(high, max(low, value))


@dataclass(frozen=True)
class Settings:
    service_token: str
    primary_provider: str
    fallback_provider: str
    reasoning_provider: str
    summary_provider: str
    fallback_enabled: bool
    ollama_url: str
    ollama_model: str
    ollama_context: int
    ollama_think: bool
    groq_key: str
    groq_model: str
    gemini_key: str
    gemini_model: str
    timeout_seconds: int
    max_concurrency: int
    max_body_bytes: int
    max_messages: int
    max_message_chars: int

    @classmethod
    def from_env(cls) -> "Settings":
        provider = os.getenv("AI_PROVIDER", "groq").strip().lower()
        if provider not in {"ollama", "groq", "gemini"}:
            provider = "groq"
        fallback = os.getenv("AI_FALLBACK_PROVIDER", "groq").strip().lower()
        if fallback not in {"ollama", "groq", "gemini"} or fallback == provider:
            fallback = "gemini" if provider == "groq" else "groq"
        reasoning = os.getenv("FREYA_REASONING_PROVIDER", "gemini").strip().lower()
        if reasoning not in {"ollama", "groq", "gemini"}:
            reasoning = provider
        summary = os.getenv("FREYA_SUMMARY_PROVIDER", "ollama").strip().lower()
        if summary not in {"ollama", "groq", "gemini"}:
            summary = "ollama"
        return cls(
            service_token=os.getenv("FREYA_SERVICE_TOKEN", ""),
            primary_provider=provider,
            fallback_provider=fallback,
            reasoning_provider=reasoning,
            summary_provider=summary,
            fallback_enabled=os.getenv("AI_FALLBACK_ENABLED", "true").lower() != "false",
            ollama_url=os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/"),
            ollama_model=os.getenv("OLLAMA_MODEL", "freya"),
            ollama_context=_bounded_int("OLLAMA_NUM_CTX", 4096, 1024, 8192),
            ollama_think=os.getenv("OLLAMA_THINK", "false").strip().lower() == "true",
            groq_key=os.getenv("GROQ_API_KEY", ""),
            groq_model=os.getenv("GROQ_MODEL", "qwen/qwen3.8-27b"),
            gemini_key=os.getenv("GEMINI_API_KEY", ""),
            gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
            timeout_seconds=_bounded_int("FREYA_PROVIDER_TIMEOUT_SECONDS", 25, 1, 120),
            max_concurrency=_bounded_int("FREYA_MAX_CONCURRENCY", 4, 1, 32),
            max_body_bytes=_bounded_int("FREYA_MAX_BODY_BYTES", 65536, 1024, 262144),
            max_messages=_bounded_int("FREYA_MAX_MESSAGES", 24, 1, 64),
            max_message_chars=_bounded_int("FREYA_MAX_MESSAGE_CHARS", 6000, 1, 20000),
        )
