/** Shared bounded sanitization for untrusted CLI and terminal text. */

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /(token|secret|password|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@");
}

export function boundedError(error: unknown, maxLength = 4_096): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message).slice(0, maxLength);
}
