import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { promoCodes, rewardTransactions } from "@/db/schema";
import { getBundles, getProducts } from "./catalog";
import { getConfig } from "./config";
import { checkPostcode, toResult } from "./postcode";
import { MAIN_CATEGORIES, formatPrice, type CartLine, type GroupSummary, type Quote, type QuoteLine, type Range } from "./types";

export async function getRewardBalance(userId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${rewardTransactions.points}), 0)::int` })
    .from(rewardTransactions)
    .where(eq(rewardTransactions.userId, userId));
  return Math.max(0, row?.total ?? 0);
}

export type QuoteInput = {
  lines: unknown;
  postcode?: string | null;
  promoCode?: string | null;
  redeemPoints?: number | null;
  userId?: number | null;
};

/**
 * The single source of truth for basket pricing and eligibility.
 * The browser only ever sends product ids and quantities; names, prices,
 * availability, delivery rules, discounts and totals are all resolved here
 * from the database, on every basket change and again when the order is placed.
 */
export async function buildQuote(input: QuoteInput): Promise<Quote> {
  const [config, allProducts, allBundles] = await Promise.all([getConfig(), getProducts(), getBundles()]);
  const pc = input.postcode ? toResult(await checkPostcode(input.postcode)) : null;
  const productById = new Map(allProducts.map((p) => [p.id, p]));
  const bundleById = new Map(allBundles.map((b) => [b.id, b]));

  const rawLines = (Array.isArray(input.lines) ? input.lines : []).slice(0, 60) as Partial<CartLine>[];
  const lines: QuoteLine[] = [];
  const seen = new Set<string>();

  for (const raw of rawLines) {
    if (!raw || typeof raw !== "object" || typeof raw.key !== "string" || seen.has(raw.key)) continue;
    const wanted = Math.floor(Number(raw.qty));
    if (!Number.isFinite(wanted) || wanted < 1) continue;
    seen.add(raw.key);

    const gone: QuoteLine = {
      key: raw.key,
      type: raw.type === "bundle" ? "bundle" : "product",
      refId: 0,
      slug: null,
      name: "Item no longer available",
      image: "",
      range: "frozen",
      variantId: null,
      variantLabel: null,
      qty: wanted,
      maxQty: wanted,
      unitPricePence: 0,
      lineTotalPence: 0,
      purchasable: false,
      eligible: false,
      issue: "This item has been removed from our menu.",
      contents: null,
    };

    if (raw.type === "product") {
      const p = productById.get(Number(raw.productId));
      if (!p) {
        lines.push(gone);
        continue;
      }
      const variant = p.variants.find((v) => v.id === raw.variantId) ?? p.variants[0];
      const qty = Math.min(wanted, p.maxPerOrder);
      lines.push({
        key: raw.key,
        type: "product",
        refId: p.id,
        slug: p.slug,
        name: p.name,
        image: p.image,
        range: p.range,
        variantId: variant?.id ?? null,
        variantLabel: variant?.label ?? null,
        qty,
        maxQty: p.maxPerOrder,
        unitPricePence: variant?.pricePence ?? 0,
        lineTotalPence: (variant?.pricePence ?? 0) * qty,
        purchasable: p.available,
        eligible: true,
        issue: !p.available ? "Currently unavailable. Remove this item to continue." : wanted > p.maxPerOrder ? `Limited to ${p.maxPerOrder} per order.` : null,
        contents: null,
      });
    } else if (raw.type === "bundle") {
      const b = bundleById.get(Number(raw.bundleId));
      if (!b) {
        lines.push(gone);
        continue;
      }
      const selections = (Array.isArray(raw.selections) ? raw.selections : [])
        .map((s) => ({ product: productById.get(Number(s?.productId)), qty: Math.floor(Number(s?.qty)) }))
        .filter((s) => Number.isFinite(s.qty) && s.qty > 0);
      let mains = 0;
      let sides = 0;
      let problem: string | null = null;
      const contents: { productId: number; name: string; qty: number }[] = [];
      for (const s of selections) {
        if (!s.product || !s.product.available) {
          problem = "A dish in this bundle is no longer available. Rebuild the bundle to continue.";
          continue;
        }
        if (s.product.range !== b.range) {
          problem = `This is a ${b.range} bundle and can only contain ${b.range} dishes.`;
          continue;
        }
        if (MAIN_CATEGORIES.includes(s.product.category)) mains += s.qty;
        else sides += s.qty;
        contents.push({ productId: s.product.id, name: s.product.name, qty: s.qty });
      }
      if (!problem && (mains !== b.mainsCount || sides !== b.sidesCount)) {
        problem = `This bundle needs exactly ${b.mainsCount} main${b.mainsCount === 1 ? "" : "s"} and ${b.sidesCount} side${b.sidesCount === 1 ? "" : "s"}.`;
      }
      const qty = Math.min(wanted, 6);
      lines.push({
        key: raw.key,
        type: "bundle",
        refId: b.id,
        slug: b.slug,
        name: b.name,
        image: b.image,
        range: b.range,
        variantId: null,
        variantLabel: `${b.mainsCount} main${b.mainsCount === 1 ? "" : "s"} + ${b.sidesCount} side${b.sidesCount === 1 ? "" : "s"}`,
        qty,
        maxQty: 6,
        unitPricePence: b.pricePence,
        lineTotalPence: b.pricePence * qty,
        purchasable: !problem,
        eligible: true,
        issue: problem,
        contents,
      });
    }
  }

  // Delivery eligibility is validated independently for each range.
  for (const line of lines) {
    if (!line.purchasable) continue;
    if (line.range === "chilled") {
      if (!pc) {
        line.eligible = false;
        line.issue ??= "Check your postcode to confirm chilled delivery.";
      } else if (!pc.chilled) {
        line.eligible = false;
        line.issue ??= `Chilled delivery isn't available for ${pc.postcode}.`;
      }
    } else if (pc && !pc.frozen) {
      line.eligible = false;
      line.issue ??= pc.frozenNote ?? `Frozen delivery isn't available for ${pc.postcode}.`;
    }
  }

  const group = (range: Range): GroupSummary | null => {
    const mine = lines.filter((l) => l.range === range && l.purchasable);
    if (!mine.length) return null;
    const rules = config.delivery[range];
    const subtotalPence = mine.reduce((s, l) => s + l.lineTotalPence, 0);
    const status: GroupSummary["status"] =
      range === "chilled" ? (!pc ? "unchecked" : pc.chilled ? "ok" : "ineligible") : pc && !pc.frozen ? "ineligible" : "ok";
    const surchargePence = range === "frozen" && pc?.frozen ? pc.frozenSurchargePence : 0;
    const free = rules.freeOverPence !== null && subtotalPence >= rules.freeOverPence;
    const deliveryPence = status === "ineligible" ? 0 : (free ? 0 : rules.chargePence) + surchargePence;
    let message: string;
    if (range === "chilled") {
      message =
        status === "ok"
          ? `Chilled delivery is available for ${pc!.postcode}. You'll choose a delivery day and time slot at checkout.`
          : status === "unchecked"
            ? "Chilled meals are delivered to selected postcodes only. Check your postcode to continue."
            : `Sorry, we don't deliver chilled meals to ${pc!.postcode}. Remove these items or try our frozen range, delivered UK-wide.`;
    } else {
      message =
        status === "ineligible"
          ? (pc?.frozenNote ?? `Frozen delivery isn't available for ${pc!.postcode}.`)
          : pc
            ? `Frozen delivery is available for ${pc.postcode} by tracked courier.${surchargePence ? ` ${pc.frozenNote ?? ""} (+${formatPrice(surchargePence)})` : ""}`
            : "Frozen meals are delivered UK-wide by tracked courier. Some remote postcodes carry a surcharge, confirmed at checkout.";
    }
    return {
      range,
      itemCount: mine.reduce((s, l) => s + l.qty, 0),
      subtotalPence,
      deliveryPence,
      surchargePence,
      minOrderPence: rules.minOrderPence,
      remainingToMinPence: Math.max(0, rules.minOrderPence - subtotalPence),
      freeOverPence: rules.freeOverPence,
      remainingToFreePence: rules.freeOverPence === null ? null : Math.max(0, rules.freeOverPence - subtotalPence),
      status,
      message: message.trim(),
    };
  };

  const chilled = group("chilled");
  const frozen = group("frozen");
  const subtotalPence = lines.filter((l) => l.purchasable).reduce((s, l) => s + l.lineTotalPence, 0);

  // Promotional code
  let promo: Quote["promo"] = null;
  const code = (input.promoCode ?? "").trim().toUpperCase().slice(0, 40);
  if (code) {
    const [row] = await db.select().from(promoCodes).where(eq(promoCodes.code, code));
    if (!row || !row.active) {
      promo = { code, valid: false, message: "That code isn't recognised.", discountPence: 0 };
    } else if (subtotalPence < row.minSpendPence) {
      promo = { code, valid: false, message: `Spend ${formatPrice(row.minSpendPence)} or more to use ${code}.`, discountPence: 0 };
    } else {
      const discountPence = row.kind === "percent" ? Math.round((subtotalPence * row.value) / 100) : Math.min(row.value, subtotalPence);
      promo = { code, valid: true, message: row.description || "Code applied.", discountPence };
    }
  }
  const discountPence = promo?.valid ? promo.discountPence : 0;

  // Reward redemption (validated against the live balance; at least £1 of goods remains payable by card)
  const { rewards: r } = config;
  const balance = input.userId ? await getRewardBalance(input.userId) : 0;
  let maxRedeemable = Math.min(balance, Math.floor(Math.max(0, subtotalPence - discountPence - 100) / r.pointValuePence));
  if (maxRedeemable < r.minRedeemPoints) maxRedeemable = 0;
  let applied = Math.min(Math.max(0, Math.floor(Number(input.redeemPoints) || 0)), maxRedeemable);
  if (applied < r.minRedeemPoints) applied = 0;
  const rewardDiscountPence = applied * r.pointValuePence;

  const deliveryPence = (chilled?.deliveryPence ?? 0) + (frozen?.deliveryPence ?? 0);
  const totalPence = subtotalPence - discountPence - rewardDiscountPence + deliveryPence;
  const pointsToEarn = Math.floor((subtotalPence - discountPence - rewardDiscountPence) / 100) * r.pointsPerPound * (r.doublePoints.active ? 2 : 1);

  const blockers: string[] = [];
  if (!lines.length) blockers.push("Your basket is empty.");
  if (lines.some((l) => !l.purchasable)) blockers.push("Remove unavailable items to continue.");
  for (const g of [chilled, frozen]) {
    if (!g) continue;
    const label = g.range === "chilled" ? "chilled" : "frozen";
    if (g.status === "unchecked") blockers.push("Check your postcode to confirm chilled delivery.");
    else if (g.status === "ineligible") blockers.push(`Remove ${label} items: ${label} delivery isn't available for ${pc?.postcode}.`);
    else if (g.remainingToMinPence > 0)
      blockers.push(`Add ${formatPrice(g.remainingToMinPence)} more from the ${label} range to reach the ${formatPrice(g.minOrderPence)} ${label} minimum.`);
  }

  return {
    lines,
    chilled,
    frozen,
    postcode: pc,
    promo,
    rewards: {
      signedIn: Boolean(input.userId),
      balance,
      maxRedeemable,
      applied,
      discountPence: rewardDiscountPence,
      pointValuePence: r.pointValuePence,
      minRedeemPoints: r.minRedeemPoints,
    },
    subtotalPence,
    discountPence,
    rewardDiscountPence,
    deliveryPence,
    totalPence,
    pointsToEarn,
    blockers,
    canCheckout: blockers.length === 0,
  };
}
