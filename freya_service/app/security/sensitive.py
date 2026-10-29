import re


PATTERNS = (
    (re.compile(r"\b(?:sk|gsk)_[A-Za-z0-9_-]{16,}\b", re.I), "[REDACTED CREDENTIAL]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b", re.I), "[REDACTED CREDENTIAL]"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"), "[REDACTED CREDENTIAL]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b", re.I), "[REDACTED CREDENTIAL]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED CREDENTIAL]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"), "[REDACTED CREDENTIAL]"),
    (re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", re.I), "[REDACTED PRIVATE KEY]"),
    (re.compile(r"\b(password|passcode|api[_ -]?key|secret|access[_ -]?token)(\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;&]+)", re.I), r"\1\2[REDACTED]"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~-]{20,}", re.I), "Bearer [REDACTED CREDENTIAL]"),
)


def redact_sensitive_credentials(value: str) -> str:
    for pattern, replacement in PATTERNS:
        value = pattern.sub(replacement, value)
    return value
