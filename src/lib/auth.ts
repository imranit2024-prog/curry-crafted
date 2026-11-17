import { cache } from "react";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import type { UserDTO } from "./types";

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

export const SESSION_COOKIE = "cc_session";
export const ORDERS_COOKIE = "cc_orders";
const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hex] = stored.split(":");
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, "hex");
  const actual = await scrypt(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Cookies are SameSite=Lax over plain http (local development). Over https they
 * are SameSite=None; Secure so the storefront also works when it is embedded in
 * a preview frame. State-changing endpoints are JSON-only (see lib/http.ts).
 */
export async function cookieOptions(maxAgeSeconds: number, httpOnly = true) {
  const h = await headers();
  const https = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
  return { httpOnly, path: "/", maxAge: maxAgeSeconds, sameSite: https ? ("none" as const) : ("lax" as const), secure: https };
}

const tokenId = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: number) {
  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({ id: tokenId(token), userId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000) });
  (await cookies()).set(SESSION_COOKIE, token, await cookieOptions(SESSION_DAYS * 86400));
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.id, tokenId(token)));
  jar.set(SESSION_COOKIE, "", await cookieOptions(0));
}

type UserRow = typeof users.$inferSelect;

export function toUserDTO(u: UserRow): UserDTO {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    referralCode: u.referralCode,
    marketingEmail: u.marketingEmail,
    marketingSms: u.marketingSms,
  };
}

export const getCurrentUser = cache(async (): Promise<UserDTO | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, tokenId(token)), gt(sessions.expiresAt, new Date())));
  return row ? toUserDTO(row.user) : null;
});

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function generateReferralCode(name: string): string {
  const stem = name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5) || "CURRY";
  return `${stem}-${randomCode(5)}`;
}

/** Order references created in this browser, so guests can view their own confirmation page. */
export async function rememberOrder(reference: string) {
  const jar = await cookies();
  const existing = (jar.get(ORDERS_COOKIE)?.value ?? "").split(",").filter(Boolean);
  const next = [reference, ...existing.filter((r) => r !== reference)].slice(0, 10);
  jar.set(ORDERS_COOKIE, next.join(","), await cookieOptions(30 * 86400));
}

export async function rememberedOrders(): Promise<string[]> {
  return ((await cookies()).get(ORDERS_COOKIE)?.value ?? "").split(",").filter(Boolean);
}

/** For pages that require a signed-in customer. Redirects to sign-in otherwise. */
export async function requireUser(next = "/account"): Promise<UserDTO> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}
