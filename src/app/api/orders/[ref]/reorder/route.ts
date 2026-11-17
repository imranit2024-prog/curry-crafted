import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { getBundles, getProducts } from "@/lib/catalog";
import { fail, ok, readJson } from "@/lib/http";
import { getOrderByReference } from "@/lib/orders";
import { POSTCODE_COOKIE, checkPostcode, toResult } from "@/lib/postcode";
import type { CartLine } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Revalidates a previous order against today's catalogue, prices and delivery rules before anything is added to the basket. */
export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  if (!(await readJson(req))) return fail("Invalid request.");
  try {
    const user = await getCurrentUser();
    if (!user) return fail("Please sign in.", 401);
    const found = await getOrderByReference(ref);
    if (!found || found.order.userId !== user.id) return fail("We couldn't find that order.", 404);

    const [products, bundles] = await Promise.all([getProducts(), getBundles()]);
    const saved = (await cookies()).get(POSTCODE_COOKIE)?.value;
    const postcode = saved ? toResult(await checkPostcode(saved)) : null;

    const items: {
      name: string;
      range: string;
      qty: number;
      wasPence: number;
      nowPence: number | null;
      status: "available" | "unavailable" | "chilled-unchecked" | "not-deliverable";
      reason: string | null;
      line: CartLine | null;
    }[] = [];

    for (const item of found.items) {
      let line: CartLine | null = null;
      let nowPence: number | null = null;
      let reason: string | null = null;
      if (item.kind === "product") {
        const p = products.find((x) => x.id === item.refId);
        if (!p || !p.available) reason = "No longer available";
        else {
          const variant = p.variants.find((v) => v.id === item.variantId) ?? p.variants[0];
          nowPence = variant.pricePence;
          line = { key: `p:${p.id}:${variant.id}`, type: "product", productId: p.id, variantId: variant.id, qty: Math.min(item.quantity, p.maxPerOrder) };
        }
      } else {
        const b = bundles.find((x) => x.id === item.refId);
        const contents = item.contents ?? [];
        const allThere = contents.every((c) => products.find((p) => p.id === c.productId)?.available);
        if (!b) reason = "This bundle is no longer offered";
        else if (!allThere) reason = "A dish in this bundle is no longer available";
        else {
          nowPence = b.pricePence;
          line = { key: `b:${b.id}:${Date.now().toString(36)}${item.id}`, type: "bundle", bundleId: b.id, selections: contents.map((c) => ({ productId: c.productId, qty: c.qty })), qty: Math.min(item.quantity, 6) };
        }
      }
      let status: (typeof items)[number]["status"] = line ? "available" : "unavailable";
      if (line && item.range === "chilled") {
        if (!postcode) {
          status = "chilled-unchecked";
          reason = "Check your postcode to confirm chilled delivery";
        } else if (!postcode.chilled) {
          status = "not-deliverable";
          reason = `Chilled delivery isn't available for ${postcode.postcode}`;
        }
      } else if (line && postcode && !postcode.frozen) {
        status = "not-deliverable";
        reason = `Frozen delivery isn't available for ${postcode.postcode}`;
      }
      items.push({ name: item.name, range: item.range, qty: item.quantity, wasPence: item.unitPricePence, nowPence, status, reason, line: status === "available" ? line : null });
    }
    return ok({ reference: found.order.reference, postcode, items });
  } catch (err) {
    console.error("reorder failed", err);
    return fail("We couldn't check that order just now. Please try again.", 500);
  }
}
