const CREDENTIAL_PATTERNS = [
  /\b(?:sk|gsk)_[A-Za-z0-9_-]{16,}\b/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/i,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:password|passcode|api[_ -]?key|secret|access[_ -]?token)\s*[:=]\s*(?:"[^"]{8,}"|'[^']{8,}'|\S{8,})/i,
];

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|gsk)_[A-Za-z0-9_-]{16,}\b/gi, "[REDACTED CREDENTIAL]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/gi, "[REDACTED CREDENTIAL]"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED CREDENTIAL]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi, "[REDACTED CREDENTIAL]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED CREDENTIAL]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED CREDENTIAL]"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]"],
  [/\b(password|passcode|api[_ -]?key|secret|access[_ -]?token)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1$2[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~-]{20,}/gi, "Bearer [REDACTED CREDENTIAL]"],
];

export function containsSensitiveCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

export function redactSensitiveCredentials(value: string): string {
  return REDACTION_PATTERNS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), value);
}
