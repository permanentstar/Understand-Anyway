/** Minimal cookie helpers (no external deps). */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      // Malformed user-supplied cookies must not break auth/token checks.
    }
  }
  return out;
}

export interface SetCookieOptions {
  maxAge?: number;
  path?: string;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
  httpOnly?: boolean;
}

export function buildSetCookie(name: string, value: string, options: SetCookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${options.path ?? "/"}`);
  if (options.maxAge !== undefined) segments.push(`Max-Age=${options.maxAge}`);
  if (options.sameSite) segments.push(`SameSite=${options.sameSite}`);
  if (options.secure) segments.push("Secure");
  if (options.httpOnly !== false) segments.push("HttpOnly");
  return segments.join("; ");
}

export function mergeSetCookieHeader(
  existing: string | string[] | undefined,
  next: string,
): string | string[] {
  if (Array.isArray(existing)) return [...existing, next];
  if (existing) return [existing, next];
  return next;
}
