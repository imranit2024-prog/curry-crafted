import { createHmac, timingSafeEqual } from "crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { addresses, orderItems, orders, referrals, rewardTransactions, users } from "@/db/schema";
import { randomCode } from "./auth";
import { getConfig, stripeConfigured } from "./config";
import { EMAIL_RE, PHONE_RE, str } from "./http";
import { checkPostcode } from "./postcode";
import { buildQuote, getRewardBalance } from "./pricing";
import { getChilledDates, getFrozenEstimate, slotHoldCondition } from "./schedule";
import type { Quote, UserDTO } from "./types";

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CheckoutResult =
  | { ok: true; reference: string; totalPence: number; paid: boolean; payment: { mode: "stripe"; url: string } | { mode: "demo" } }
  | { ok: false; status: number; error: string; fields?: Record<string, string>; quote?: Quote };

/* ------------------------------------------------------------------ */
/* Stripe (REST API, no SDK required)                                  */
/* ------------------------------------------------------------------ */

async function stripeRequest(path: string, params?: URLSearchParams, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: params ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: params?.toString(),
    cache: "no-store",
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const message = (data.error as { message?: string } | undefined)?.message ?? "Stripe request failed";
    throw new Error(message);
  }
  return data;
}

async function createStripeSession(order: OrderRow, origin: string): Promise<{ id: string; url: string }> {
  const params = new URLSearchParams({
    mode: "payment",
    success_url: `${origin}/checkout/confirmation/${order.reference}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/checkout?payment=cancelled`,
    customer_email: order.email,
    client_reference_id: order.reference,
    "metadata[order_reference]": order.reference,
    "payment_intent_data[metadata][order_reference]": order.reference,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "gbp",
    "line_items[0][price_data][unit_amount]": String(order.totalPence),
    "line_items[0][price_data][product_data][name]": `Curry Crafted order ${order.reference}`,
  });
  // The Stripe idempotency key is tied to the order, so a retried request can never create a second charge.
  const session = await stripeRequest("/checkout/sessions", params, `cc-order-${order.reference}`);
  return { id: String(session.id), url: String(session.url) };
}

/** Called when the customer returns from Stripe: confirm with Stripe before marking the order paid. */
export async function syncStripePayment(order: OrderRow): Promise<OrderRow> {
  if (order.paymentStatus === "paid" || order.paymentMode !== "stripe" || !order.stripeSessionId || !stripeConfigured()) return order;
  try {
    const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(order.stripeSessionId)}`);
    if (session.payment_status === "paid" && session.client_reference_id === order.reference) {
      await finalizeOrder(order.id);
      const [fresh] = await db.select().from(orders).where(eq(orders.id, order.id));
      return fresh ?? order;
    }
  } catch (err) {
    console.error("Stripe session lookup failed", err);
  }
  return order;
}

export function verifyStripeSignature(payload: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const timestamp = Number(parts.t);
  if (!timestamp || !parts.v1 || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${payload}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Order creation                                                      */
/* ------------------------------------------------------------------ */

class SlotFullError extends Error {}

async function paymentFor(order: OrderRow, origin: string): Promise<CheckoutResult> {
  const base = { ok: true as const, reference: order.reference, totalPence: order.totalPence, paid: order.paymentStatus === "paid" };
  if (order.paymentMode !== "stripe") return { ...base, payment: { mode: "demo" } };
  if (order.stripeUrl && order.stripeSessionId) return { ...base, payment: { mode: "stripe", url: order.stripeUrl } };
  try {
    const session = await createStripeSession(order, origin);
    await db.update(orders).set({ stripeSessionId: session.id, stripeUrl: session.url }).where(eq(orders.id, order.id));
    return { ...base, payment: { mode: "stripe", url: session.url } };
  } catch (err) {
    console.error("Stripe session creation failed", err);
    return { ok: false, status: 502, error: "We couldn't start the secure payment. Your basket is safe — please try again." };
  }
}

export async function createOrder(body: Record<string, unknown>, user: UserDTO | null, origin: string): Promise<CheckoutResult> {
  const config = await getConfig();
  if (!user && !config.guestCheckout) return { ok: false, status: 401, error: "Please sign in to place an order." };

  const customer = (body.customer ?? {}) as Record<string, unknown>;
  const addr = (body.address ?? {}) as Record<string, unknown>;
  const name = str(customer.name, 120);
  const email = str(customer.email, 200).toLowerCase();
  const phone = str(customer.phone, 30);
  const line1 = str(addr.line1, 160);
  const line2 = str(addr.line2, 160);
  const city = str(addr.city, 80);
  const idempotencyKey = str(body.idempotencyKey, 80);

  const fields: Record<string, string> = {};
  if (name.length < 2) fields.name = "Enter your full name.";
  if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email address.";
  if (!PHONE_RE.test(phone)) fields.phone = "Enter a valid telephone number.";
  if (line1.length < 3) fields.line1 = "Enter the first line of your address.";
  if (city.length < 2) fields.city = "Enter your town or city.";
  const pc = await checkPostcode(str(addr.postcode, 12));
  if (!pc.valid) fields.postcode = pc.error;
  if (idempotencyKey.length < 12) return { ok: false, status: 400, error: "Something went wrong preparing your order. Please refresh and try again." };
  if (Object.keys(fields).length || !pc.valid) return { ok: false, status: 422, error: "Please check the highlighted details.", fields };

  // Duplicate submission: return the order that already exists for this attempt.
  const [existing] = await db.select().from(orders).where(eq(orders.idempotencyKey, idempotencyKey));
  if (existing) return paymentFor(existing, origin);

  // Re-price everything from the database at the moment of ordering.
  const quote = await buildQuote({
    lines: body.lines,
    postcode: pc.postcode,
    promoCode: str(body.promoCode, 40) || null,
    redeemPoints: Number(body.redeemPoints) || 0,
    userId: user?.id ?? null,
  });
  if (!quote.canCheckout) return { ok: false, status: 409, error: quote.blockers[0] ?? "Your basket can't be checked out yet.", quote };
  if (quote.totalPence !== Number(body.expectedTotalPence)) {
    return { ok: false, status: 409, error: "Prices or delivery charges have changed since you last reviewed your order. Please review the updated total.", quote };
  }

  let chilledDate: string | null = null;
  let chilledSlotId: string | null = null;
  let chilledSlotLabel: string | null = null;
  if (quote.chilled) {
    const dates = await getChilledDates();
    const date = dates.find((d) => d.date === str(body.chilledDate, 10));
    const slot = date?.slots.find((s) => s.id === str(body.chilledSlotId, 20));
    if (!date || !slot) return { ok: false, status: 422, error: "Choose a delivery day and time slot for your chilled meals." };
    if (!date.open) return { ok: false, status: 409, error: `The order cut-off for ${date.longLabel} has passed. Please choose another day.` };
    if (!slot.available) return { ok: false, status: 409, error: `The ${slot.label} slot on ${date.longLabel} is now fully booked. Please choose another slot.` };
    chilledDate = date.date;
    chilledSlotId = slot.id;
    chilledSlotLabel = `${date.longLabel}, ${slot.label}`;
  }
  const frozen = quote.frozen ? await getFrozenEstimate() : null;

  let order: OrderRow;
  try {
    order = await db.transaction(async (tx) => {
      if (chilledDate && chilledSlotId) {
        // Serialise bookings for this slot so capacity can never be oversold.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${chilledDate}:${chilledSlotId}`}))`);
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(orders)
          .where(and(eq(orders.chilledDate, chilledDate), eq(orders.chilledSlotId, chilledSlotId), slotHoldCondition()));
        if (count >= config.chilledSchedule.capacityPerSlot) throw new SlotFullError();
      }
      const [row] = await tx
        .insert(orders)
        .values({
          reference: `CC-${randomCode(8)}`,
          idempotencyKey,
          userId: user?.id ?? null,
          name,
          email,
          phone,
          address: { line1, line2, city, postcode: pc.postcode },
          paymentMode: stripeConfigured() ? "stripe" : "demo",
          subtotalPence: quote.subtotalPence,
          promoCode: quote.promo?.valid ? quote.promo.code : null,
          discountPence: quote.discountPence,
          rewardPointsRedeemed: quote.rewards.applied,
          rewardDiscountPence: quote.rewardDiscountPence,
          chilledDeliveryPence: quote.chilled?.deliveryPence ?? 0,
          frozenDeliveryPence: quote.frozen?.deliveryPence ?? 0,
          totalPence: quote.totalPence,
          pointsEarned: user ? quote.pointsToEarn : 0,
          chilledDate,
          chilledSlotId,
          chilledSlotLabel,
          frozenDispatchDate: frozen?.dispatchDate ?? null,
          frozenEstimate: frozen ? `Dispatched ${frozen.dispatchLabel} · estimated delivery ${frozen.estimateLabel}` : null,
        })
        .returning();
      await tx.insert(orderItems).values(
        quote.lines.map((l) => ({
          orderId: row.id,
          kind: l.type,
          refId: l.refId,
          variantId: l.variantId,
          name: l.name,
          image: l.image,
          range: l.range,
          variantLabel: l.variantLabel,
          quantity: l.qty,
          unitPricePence: l.unitPricePence,
          lineTotalPence: l.lineTotalPence,
          contents: l.contents,
        })),
      );
      return row;
    });
  } catch (err) {
    if (err instanceof SlotFullError) {
      return { ok: false, status: 409, error: "That delivery slot has just been fully booked. Please choose another slot." };
    }
    // A concurrent duplicate submission hit the unique idempotency key first.
    const [dupe] = await db.select().from(orders).where(eq(orders.idempotencyKey, idempotencyKey));
    if (dupe) return paymentFor(dupe, origin);
    throw err;
  }

  if (user && body.saveAddress === true) {
    const mine = await db.select().from(addresses).where(eq(addresses.userId, user.id));
    const same = mine.some((a) => a.line1.toLowerCase() === line1.toLowerCase() && a.postcode === pc.postcode);
    if (!same && mine.length < 10) {
      await db.insert(addresses).values({ userId: user.id, label: mine.length ? "Address" : "Home", line1, line2, city, postcode: pc.postcode, isDefault: mine.length === 0 });
    }
  }

  return paymentFor(order, origin);
}

/* ------------------------------------------------------------------ */
/* Payment completion: idempotent, awards loyalty & referral rewards   */
/* ------------------------------------------------------------------ */

async function balanceIn(tx: Tx, userId: number): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${rewardTransactions.points}), 0)::int` })
    .from(rewardTransactions)
    .where(eq(rewardTransactions.userId, userId));
  return Math.max(0, row?.total ?? 0);
}

export async function finalizeOrder(orderId: number): Promise<void> {
  const config = await getConfig();
  await db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!order || order.paymentStatus === "paid") return; // already processed: never award twice
    await tx.update(orders).set({ paymentStatus: "paid", status: "confirmed", paidAt: new Date() }).where(eq(orders.id, orderId));
    if (!order.userId) return;

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + config.rewards.expiryMonths);

    if (order.rewardPointsRedeemed > 0) {
      const balance = await balanceIn(tx, order.userId);
      await tx.insert(rewardTransactions).values({
        userId: order.userId,
        orderId,
        kind: "redeem",
        points: -Math.min(order.rewardPointsRedeemed, balance),
        description: `Redeemed on order ${order.reference}`,
      });
    }
    if (order.pointsEarned > 0) {
      await tx.insert(rewardTransactions).values({
        userId: order.userId,
        orderId,
        kind: "earn",
        points: order.pointsEarned,
        description: `Earned on order ${order.reference}${config.rewards.doublePoints.active ? " (double points)" : ""}`,
        expiresAt,
      });
    }

    // Referral rewards are only released once the referred customer's order meets the qualifying spend.
    const goodsPaid = order.subtotalPence - order.discountPence - order.rewardDiscountPence;
    if (goodsPaid >= config.referral.minQualifyingOrderPence) {
      const [referral] = await tx
        .select()
        .from(referrals)
        .where(and(eq(referrals.referredUserId, order.userId), eq(referrals.status, "registered")))
        .for("update");
      if (referral) {
        await tx
          .update(referrals)
          .set({ status: "qualified", qualifiedAt: new Date(), rewardPoints: config.referral.referrerPoints })
          .where(eq(referrals.id, referral.id));
        await tx.insert(rewardTransactions).values([
          { userId: referral.referrerUserId, orderId, kind: "referral", points: config.referral.referrerPoints, description: "Referral reward: your friend placed a qualifying order", expiresAt },
          { userId: order.userId, orderId, kind: "referral", points: config.referral.friendPoints, description: "Welcome reward for joining through a friend", expiresAt },
        ]);
      }
    }
  });
}

/** Demo payments are only possible when no Stripe key is configured. */
export async function recordFailedPayment(orderId: number) {
  await db.update(orders).set({ paymentStatus: "failed" }).where(and(eq(orders.id, orderId), inArray(orders.paymentStatus, ["unpaid", "failed"])));
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function getOrderByReference(reference: string): Promise<{ order: OrderRow; items: OrderItemRow[] } | null> {
  const [order] = await db.select().from(orders).where(eq(orders.reference, reference.toUpperCase()));
  if (!order) return null;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(orderItems.id);
  return { order, items };
}

export async function getOrdersForUser(userId: number): Promise<{ order: OrderRow; items: OrderItemRow[] }[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.paymentStatus, "paid")))
    .orderBy(desc(orders.createdAt));
  if (!rows.length) return [];
  const items = await db
    .select()
    .from(orderItems)
    .where(
      inArray(
        orderItems.orderId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(orderItems.id);
  return rows.map((order) => ({ order, items: items.filter((i) => i.orderId === order.id) }));
}

export async function getRewardSummary(userId: number) {
  const [history, balance, referralRows] = await Promise.all([
    db.select().from(rewardTransactions).where(eq(rewardTransactions.userId, userId)).orderBy(desc(rewardTransactions.createdAt)),
    getRewardBalance(userId),
    db
      .select({ referral: referrals, friendName: users.name })
      .from(referrals)
      .innerJoin(users, eq(users.id, referrals.referredUserId))
      .where(eq(referrals.referrerUserId, userId))
      .orderBy(desc(referrals.createdAt)),
  ]);
  const earned = history.filter((h) => h.points > 0).reduce((s, h) => s + h.points, 0);
  const redeemed = history.filter((h) => h.points < 0).reduce((s, h) => s - h.points, 0);
  const nextExpiry = history
    .filter((h) => h.points > 0 && h.expiresAt)
    .map((h) => h.expiresAt as Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return { history, balance, earned, redeemed, nextExpiry: nextExpiry ?? null, referrals: referralRows };
}

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending_payment: "Awaiting payment",
  confirmed: "Confirmed",
  preparing: "Being prepared",
  dispatched: "On its way",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
