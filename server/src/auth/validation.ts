export const USERNAME_MAX = 64;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

export function validUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/.test(value)
  );
}

export function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX;
}

export function validEmail(value: unknown, optional = true): boolean {
  if ((value === undefined || value === "") && optional) return true;
  if (typeof value !== "string" || value.length > 254 || value !== value.trim()) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function validPhone(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim().length <= 64);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
  return isPlainRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}
