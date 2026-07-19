const SENSITIVE_QUERY_KEYS = new Set(["token", "setupToken", "resetToken", "inviteToken"]);

export function redactSensitiveUrl(value: string): string {
  try {
    const url = new URL(value, "http://harbor.invalid");
    for (const key of [...url.searchParams.keys()])
      if (SENSITIVE_QUERY_KEYS.has(key)) url.searchParams.set(key, "[REDACTED]");
    return `${url.pathname}${url.search}`;
  } catch {
    return value.split("?")[0];
  }
}

export function requestLogShape(req: any): Record<string, unknown> {
  return {
    method: req.method,
    url: redactSensitiveUrl(String(req.url || "")),
    host: req.hostname || req.headers?.host,
    remoteAddress: req.ip || req.socket?.remoteAddress,
  };
}
