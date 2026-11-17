import { getProducts, searchProducts } from "@/lib/catalog";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 60);
    const all = await getProducts();
    const list = q ? searchProducts(all, q) : all.filter((p) => p.featured);
    return ok({
      query: q,
      total: list.length,
      results: list.slice(0, 6).map((p) => ({
        slug: p.slug,
        name: p.name,
        image: p.image,
        range: p.range,
        category: p.category,
        pricePence: p.pricePence,
        available: p.available,
      })),
    });
  } catch (err) {
    console.error("search failed", err);
    return fail("Search is unavailable right now.", 500);
  }
}
