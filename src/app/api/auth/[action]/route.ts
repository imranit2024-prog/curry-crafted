import { eq } from "drizzle-orm";
import { db } from "@/db";
import { referrals, users } from "@/db/schema";
import { createSession, destroySession, generateReferralCode, getCurrentUser, hashPassword, toUserDTO, verifyPassword } from "@/lib/auth";
import { EMAIL_RE, PHONE_RE, fail, ok, readJson, str } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action !== "me") return fail("Not found.", 404);
  return ok({ user: await getCurrentUser() });
}

export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  const body = await readJson(req);
  if (!body) return fail("Invalid request.");
  try {
    if (action === "logout") {
      await destroySession();
      return ok({ user: null });
    }

    if (action === "login") {
      const email = str(body.email, 200).toLowerCase();
      const password = typeof body.password === "string" ? body.password : "";
      const fields: Record<string, string> = {};
      if (!EMAIL_RE.test(email)) fields.email = "Enter your email address.";
      if (!password) fields.password = "Enter your password.";
      if (Object.keys(fields).length) return fail("Please check the highlighted fields.", 422, { fields });
      const [user] = await db.select().from(users).where(eq(users.email, email));
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return fail("That email and password don't match our records.", 401);
      }
      await createSession(user.id);
      return ok({ user: toUserDTO(user) });
    }

    if (action === "register") {
      const name = str(body.name, 120);
      const email = str(body.email, 200).toLowerCase();
      const phone = str(body.phone, 30);
      const password = typeof body.password === "string" ? body.password : "";
      const confirm = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
      const referralCode = str(body.referralCode, 20).toUpperCase();
      const fields: Record<string, string> = {};
      if (name.length < 2) fields.name = "Enter your full name.";
      if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email address.";
      if (!PHONE_RE.test(phone)) fields.phone = "Enter a valid telephone number.";
      if (password.length < 8) fields.password = "Use at least 8 characters.";
      else if (password.length > 200) fields.password = "That password is too long.";
      if (confirm !== password) fields.confirmPassword = "Passwords don't match.";
      let referrer: typeof users.$inferSelect | undefined;
      if (referralCode) {
        [referrer] = await db.select().from(users).where(eq(users.referralCode, referralCode));
        if (!referrer) fields.referralCode = "We don't recognise that referral code.";
      }
      if (Object.keys(fields).length) return fail("Please check the highlighted fields.", 422, { fields });
      const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (taken) return fail("Please check the highlighted fields.", 422, { fields: { email: "An account already exists for this email. Try signing in." } });

      const marketingEmail = body.marketingEmail === true;
      const [user] = await db
        .insert(users)
        .values({
          name,
          email,
          phone,
          passwordHash: await hashPassword(password),
          referralCode: generateReferralCode(name),
          referredByUserId: referrer?.id ?? null,
          marketingEmail,
          marketingUpdatedAt: marketingEmail ? new Date() : null,
        })
        .returning();
      if (referrer) await db.insert(referrals).values({ referrerUserId: referrer.id, referredUserId: user.id }).onConflictDoNothing();
      await createSession(user.id);
      return ok({ user: toUserDTO(user) });
    }

    return fail("Not found.", 404);
  } catch (err) {
    console.error("auth failed", err);
    return fail("Something went wrong. Please try again.", 500);
  }
}
