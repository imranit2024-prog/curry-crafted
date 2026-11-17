import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { addresses, users } from "@/db/schema";
import { getCurrentUser, hashPassword, toUserDTO, verifyPassword } from "@/lib/auth";
import { EMAIL_RE, PHONE_RE, fail, ok, readJson, str } from "@/lib/http";
import { parsePostcode } from "@/lib/postcode";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ resource: string }> };

async function listAddresses(userId: number) {
  const rows = await db.select().from(addresses).where(eq(addresses.userId, userId)).orderBy(addresses.id);
  return rows.map((a) => ({ id: a.id, label: a.label, line1: a.line1, line2: a.line2, city: a.city, postcode: a.postcode, isDefault: a.isDefault }));
}

export async function GET(_req: Request, ctx: Ctx) {
  const { resource } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return fail("Please sign in.", 401);
  if (resource === "addresses") return ok({ addresses: await listAddresses(user.id) });
  return fail("Not found.", 404);
}

export async function POST(req: Request, ctx: Ctx) {
  const { resource } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return fail("Please sign in.", 401);
  const body = await readJson(req);
  if (!body) return fail("Invalid request.");
  try {
    if (resource === "addresses") {
      const action = str(body.action, 20) || "create";
      const id = Number(body.id);
      if (action === "delete") {
        await db.delete(addresses).where(and(eq(addresses.id, id), eq(addresses.userId, user.id)));
        return ok({ addresses: await listAddresses(user.id) });
      }
      if (action === "default") {
        await db.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, user.id));
        await db.update(addresses).set({ isDefault: true }).where(and(eq(addresses.id, id), eq(addresses.userId, user.id)));
        return ok({ addresses: await listAddresses(user.id) });
      }
      const line1 = str(body.line1, 160);
      const city = str(body.city, 80);
      const pc = parsePostcode(str(body.postcode, 12));
      const fields: Record<string, string> = {};
      if (line1.length < 3) fields.line1 = "Enter the first line of the address.";
      if (city.length < 2) fields.city = "Enter a town or city.";
      if (!pc) fields.postcode = "Enter a full UK postcode.";
      if (Object.keys(fields).length || !pc) return fail("Please check the highlighted fields.", 422, { fields });
      const existing = await listAddresses(user.id);
      if (existing.length >= 10) return fail("You can save up to 10 addresses.", 422);
      const makeDefault = body.isDefault === true || existing.length === 0;
      if (makeDefault) await db.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, user.id));
      await db.insert(addresses).values({ userId: user.id, label: str(body.label, 40) || "Home", line1, line2: str(body.line2, 160), city, postcode: pc.formatted, isDefault: makeDefault });
      return ok({ addresses: await listAddresses(user.id) });
    }

    if (resource === "details") {
      const name = str(body.name, 120);
      const email = str(body.email, 200).toLowerCase();
      const phone = str(body.phone, 30);
      const fields: Record<string, string> = {};
      if (name.length < 2) fields.name = "Enter your full name.";
      if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email address.";
      if (!PHONE_RE.test(phone)) fields.phone = "Enter a valid telephone number.";
      if (Object.keys(fields).length) return fail("Please check the highlighted fields.", 422, { fields });
      const [taken] = await db.select({ id: users.id }).from(users).where(and(eq(users.email, email), ne(users.id, user.id)));
      if (taken) return fail("Please check the highlighted fields.", 422, { fields: { email: "That email is already used by another account." } });
      const [updated] = await db.update(users).set({ name, email, phone }).where(eq(users.id, user.id)).returning();
      return ok({ user: toUserDTO(updated) });
    }

    if (resource === "password") {
      const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
      const next = typeof body.newPassword === "string" ? body.newPassword : "";
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      const fields: Record<string, string> = {};
      if (!row || !(await verifyPassword(current, row.passwordHash))) fields.currentPassword = "Your current password isn't correct.";
      if (next.length < 8 || next.length > 200) fields.newPassword = "Use at least 8 characters.";
      if (Object.keys(fields).length) return fail("Please check the highlighted fields.", 422, { fields });
      await db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, user.id));
      return ok({ updated: true });
    }

    if (resource === "preferences") {
      const [updated] = await db
        .update(users)
        .set({ marketingEmail: body.marketingEmail === true, marketingSms: body.marketingSms === true, marketingUpdatedAt: new Date() })
        .where(eq(users.id, user.id))
        .returning();
      return ok({ user: toUserDTO(updated) });
    }

    return fail("Not found.", 404);
  } catch (err) {
    console.error("account update failed", err);
    return fail("Something went wrong. Please try again.", 500);
  }
}
