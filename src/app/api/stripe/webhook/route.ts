import { fail, ok } from "@/lib/http";
import { finalizeOrder, getOrderByReference, verifyStripeSignature } from "@/lib/orders";

export const dynamic = "force-dynamic";

/** Stripe webhook: marks orders paid even if the customer never returns to the confirmation page. */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return fail("Webhook secret not configured.", 503);
  const payload = await req.text();
  if (!verifyStripeSignature(payload, req.headers.get("stripe-signature"), secret)) return fail("Invalid signature.", 400);
  try {
    const event = JSON.parse(payload) as { type?: string; data?: { object?: Record<string, unknown> } };
    const session = event.data?.object ?? {};
    if ((event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") && session.payment_status === "paid") {
      const found = await getOrderByReference(String(session.client_reference_id ?? ""));
      if (found && found.order.stripeSessionId === session.id) await finalizeOrder(found.order.id);
    }
    return ok({ received: true });
  } catch (err) {
    console.error("webhook failed", err);
    return fail("Webhook processing failed.", 500);
  }
}
