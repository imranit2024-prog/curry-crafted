import { cookies } from "next/headers";
import { cookieOptions, getCurrentUser, rememberOrder } from "@/lib/auth";
import { fail, ok, readJson, requestOrigin } from "@/lib/http";
import { createOrder } from "@/lib/orders";
import { POSTCODE_COOKIE } from "@/lib/postcode";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return fail("Invalid request.");
  try {
    const user = await getCurrentUser();
    const result = await createOrder(body, user, requestOrigin(req));
    if (!result.ok) return fail(result.error, result.status, { fields: result.fields, quote: result.quote });
    await rememberOrder(result.reference);
    const address = body.address as { postcode?: string } | undefined;
    if (address?.postcode) (await cookies()).set(POSTCODE_COOKIE, String(address.postcode).toUpperCase().slice(0, 9), await cookieOptions(30 * 86400));
    return ok(result);
  } catch (err) {
    console.error("checkout failed", err);
    return fail("We couldn't place your order just now. You haven't been charged and your basket is safe. Please try again.", 500);
  }
}
