import { getCurrentUser, rememberedOrders } from "@/lib/auth";
import { stripeConfigured } from "@/lib/config";
import { fail, ok, readJson, str } from "@/lib/http";
import { finalizeOrder, getOrderByReference, recordFailedPayment } from "@/lib/orders";

export const dynamic = "force-dynamic";

/**
 * DEMO PAYMENT ENDPOINT. Active only while STRIPE_SECRET_KEY is not configured.
 * It never takes money and never stores card details: it simply lets the
 * success and decline journeys be reviewed using Stripe's published test numbers.
 */
export async function POST(req: Request) {
  if (stripeConfigured()) return fail("Demo payments are disabled because Stripe is connected.", 403);
  const body = await readJson(req);
  if (!body) return fail("Invalid request.");
  try {
    const found = await getOrderByReference(str(body.reference, 20));
    const user = await getCurrentUser();
    const allowed = found && ((user && found.order.userId === user.id) || (await rememberedOrders()).includes(found.order.reference));
    if (!found || !allowed) return fail("We couldn't find that order.", 404);
    if (found.order.paymentStatus === "paid") return ok({ status: "paid", reference: found.order.reference }); // repeat submission: no second payment

    const card = str(body.cardNumber, 30).replace(/\D/g, "");
    const expiry = /^(\d{2})\s*\/\s*(\d{2})$/.exec(str(body.expiry, 8));
    const cvc = str(body.cvc, 4);
    const fields: Record<string, string> = {};
    if (card.length !== 16) fields.cardNumber = "Enter the 16-digit card number.";
    if (!expiry || Number(expiry[1]) < 1 || Number(expiry[1]) > 12) fields.expiry = "Use the format MM/YY.";
    else {
      const end = new Date(2000 + Number(expiry[2]), Number(expiry[1]), 1);
      if (end.getTime() <= Date.now()) fields.expiry = "This card has expired.";
    }
    if (!/^\d{3,4}$/.test(cvc)) fields.cvc = "Enter the 3-digit security code.";
    if (Object.keys(fields).length) return fail("Please check your card details.", 422, { fields });

    await new Promise((r) => setTimeout(r, 700));
    if (card === "4242424242424242") {
      await finalizeOrder(found.order.id);
      return ok({ status: "paid", reference: found.order.reference });
    }
    await recordFailedPayment(found.order.id);
    if (card === "4000000000000002") {
      return fail("Your card was declined. You haven't been charged and your basket has been kept. Try another card.", 402, { code: "card_declined" });
    }
    return fail("This preview only accepts Stripe test cards: 4242 4242 4242 4242 succeeds, 4000 0000 0000 0002 is declined.", 402, { code: "test_card_required" });
  } catch (err) {
    console.error("demo payment failed", err);
    return fail("The payment couldn't be processed. You haven't been charged. Please try again.", 500);
  }
}
