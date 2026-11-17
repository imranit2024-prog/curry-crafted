export function ok<T>(data: T, init?: ResponseInit) {
  return Response.json(data, init);
}

export function fail(error: string, status = 400, extra: Record<string, unknown> = {}) {
  return Response.json({ error, ...extra }, { status });
}

/**
 * Mutating endpoints only accept JSON bodies. Browsers cannot send a
 * cross-site `application/json` request without a CORS preflight (which this
 * app never approves), so this doubles as CSRF protection.
 */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return null;
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function str(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const PHONE_RE = /^[0-9+()\s-]{7,20}$/;

export function requestOrigin(req: Request): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const h = req.headers;
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000").split(",")[0].trim();
  const proto = (h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")).split(",")[0].trim();
  return `${proto}://${host}`;
}
