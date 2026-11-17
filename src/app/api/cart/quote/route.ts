import { getCurrentUser } from "@/lib/auth";
import { fail, ok, readJson, str } from "@/lib/http";
import { buildQuote } from "@/lib/pricing";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return fail("Invalid request.");
  try {
    const user = await getCurrentUser();
    const quote = await buildQuote({
      lines: body.lines,
      postcode: str(body.postcode, 12) || null,
      promoCode: str(body.promoCode, 40) || null,
      redeemPoints: Number(body.redeemPoints) || 0,
      userId: user?.id ?? null,
    });
    return ok({ quote });
  } catch (err) {
    console.error("quote failed", err);
    return fail("We couldn't update your basket just now. Please try again.", 500);
  }
}
