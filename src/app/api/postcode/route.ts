import { cookies } from "next/headers";
import { cookieOptions } from "@/lib/auth";
import { fail, ok, readJson, str } from "@/lib/http";
import { POSTCODE_COOKIE, checkPostcode, toResult } from "@/lib/postcode";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return fail("Invalid request.");
  try {
    const check = await checkPostcode(str(body.postcode, 12));
    if (!check.valid) return fail(check.error, 422);
    // Remember the validated postcode for the rest of the shopping session.
    (await cookies()).set(POSTCODE_COOKIE, check.postcode, await cookieOptions(30 * 86400));
    return ok({ result: toResult(check) });
  } catch (err) {
    console.error("postcode check failed", err);
    return fail("We couldn't check that postcode just now. Please try again.", 500);
  }
}

export async function DELETE() {
  (await cookies()).set(POSTCODE_COOKIE, "", await cookieOptions(0));
  return ok({ cleared: true });
}
