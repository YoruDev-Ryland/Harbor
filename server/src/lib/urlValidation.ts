export function normalizeHttpUrl(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw && allowEmpty) return "";
  if (!raw || raw.length > 2_048 || /[\r\n]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      !url.hostname
    )
      return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}
