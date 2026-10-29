from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..security.sensitive import redact_sensitive_credentials


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: str
    content: str

    @field_validator("role")
    @classmethod
    def role_allowed(cls, value: str) -> str:
        if value not in {"user", "assistant"}:
            raise ValueError("Unsupported message role")
        return value

    @field_validator("content")
    @classmethod
    def content_bounded_and_redacted(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 6000:
            raise ValueError("Message content must contain 1-6000 characters")
        return redact_sensitive_credentials(value)


class ChatPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    system: str = Field(min_length=1, max_length=24000)
    messages: list[Message] = Field(min_length=1, max_length=24)
    privacy_mode: bool = False
    ollama_model: str | None = Field(default=None, min_length=1, max_length=160, pattern=r"^[\w./:-]+$")

    @field_validator("system")
    @classmethod
    def system_redacts_credentials(cls, value: str) -> str:
        return redact_sensitive_credentials(value)

    @field_validator("messages")
    @classmethod
    def conversation_ends_with_user(cls, value: list[Message]) -> list[Message]:
        if value[-1].role != "user":
            raise ValueError("Final message must be from the user")
        return value


class ChatResponse(BaseModel):
    reply: str
    provider: str
    task: str
