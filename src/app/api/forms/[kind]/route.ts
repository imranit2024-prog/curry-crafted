import { db } from "@/db";
import { contactMessages, newsletterSubscribers } from "@/db/schema";
import { EMAIL_RE, fail, ok, readJson, str } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  const body = await readJson(req);
  if (!body) return fail("Invalid request.");
  try {
    const email = str(body.email, 200).toLowerCase();
    if (kind === "newsletter") {
      const fields: Record<string, string> = {};
      if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email address.";
      if (body.consent !== true) fields.consent = "Please confirm you'd like to receive our emails.";
      if (Object.keys(fields).length) return fail(Object.values(fields)[0], 422, { fields });
      await db.insert(newsletterSubscribers).values({ email, consent: true }).onConflictDoNothing();
      return ok({ subscribed: true });
    }
    if (kind === "contact") {
      const name = str(body.name, 120);
      const message = str(body.message, 4000);
      const fields: Record<string, string> = {};
      if (name.length < 2) fields.name = "Enter your name.";
      if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email address.";
      if (message.length < 10) fields.message = "Tell us a little more so we can help (at least 10 characters).";
      if (Object.keys(fields).length) return fail("Please check the highlighted fields.", 422, { fields });
      await db.insert(contactMessages).values({ name, email, topic: str(body.topic, 60) || "General", message });
      return ok({ sent: true });
    }
    return fail("Not found.", 404);
  } catch (err) {
    console.error("form failed", err);
    return fail("Something went wrong. Please try again.", 500);
  }
}
