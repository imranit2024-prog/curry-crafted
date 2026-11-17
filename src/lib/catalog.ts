import { cache } from "react";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { bundles, products } from "@/db/schema";
import { ensureSeeded } from "./seed";
import { MAIN_CATEGORIES, type BundleDTO, type Nutrition, type ProductDTO, type Range } from "./types";

type ProductRow = typeof products.$inferSelect;

function toDTO(row: ProductRow): ProductDTO {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    range: row.range as Range,
    category: row.category,
    shortDescription: row.shortDescription,
    description: row.description,
    image: row.image,
    gallery: row.gallery?.length ? row.gallery : [row.image],
    pricePence: row.variants[0]?.pricePence ?? 0,
    variants: row.variants,
    dietary: row.dietary,
    spiceLevel: row.spiceLevel,
    ingredients: row.ingredients,
    allergens: row.allergens,
    mayContain: row.mayContain,
    nutrition: (row.nutrition as Nutrition | null) ?? null,
    storage: row.storage,
    preparation: row.preparation,
    servings: row.servings,
    available: row.active && row.inStock && row.variants.length > 0,
    maxPerOrder: row.maxPerOrder,
    popularity: row.popularity,
    featured: row.featured,
    createdAt: row.createdAt.toISOString(),
  };
}

/** All listed products (active). `available` is false when a listed product can't currently be bought. */
export const getProducts = cache(async (): Promise<ProductDTO[]> => {
  await ensureSeeded();
  const rows = await db.select().from(products).where(eq(products.active, true));
  return rows.map(toDTO).sort((a, b) => b.popularity - a.popularity);
});

export async function getProductBySlug(slug: string): Promise<ProductDTO | null> {
  const all = await getProducts();
  return all.find((p) => p.slug === slug) ?? null;
}

export const getBundles = cache(async (): Promise<BundleDTO[]> => {
  await ensureSeeded();
  const [rows, all] = await Promise.all([
    db.select().from(bundles).where(eq(bundles.active, true)).orderBy(asc(bundles.sortOrder)),
    getProducts(),
  ]);
  return rows.map((b) => {
    const eligible = all.filter((p) => p.range === b.range && p.available);
    const maxMain = Math.max(0, ...eligible.filter((p) => MAIN_CATEGORIES.includes(p.category)).map((p) => p.pricePence));
    const maxSide = Math.max(0, ...eligible.filter((p) => !MAIN_CATEGORIES.includes(p.category)).map((p) => p.pricePence));
    const maxValue = maxMain * b.mainsCount + maxSide * b.sidesCount;
    return {
      id: b.id,
      slug: b.slug,
      name: b.name,
      description: b.description,
      image: b.image,
      range: b.range as Range,
      serves: b.serves,
      mainsCount: b.mainsCount,
      sidesCount: b.sidesCount,
      pricePence: b.pricePence,
      saveUpToPence: Math.max(0, maxValue - b.pricePence),
    };
  });
});

export function searchProducts(all: ProductDTO[], query: string): ProductDTO[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return all
    .map((p) => {
      const name = p.name.toLowerCase();
      const hay = `${name} ${p.category} ${p.range} ${p.shortDescription} ${p.description} ${p.dietary.join(" ")} ${p.ingredients}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return null;
      const score = terms.reduce((s, t) => s + (name.startsWith(t) ? 6 : name.includes(t) ? 4 : p.category.includes(t) || p.range.includes(t) ? 2 : 1), 0);
      return { p, score };
    })
    .filter((x): x is { p: ProductDTO; score: number } => x !== null)
    .sort((a, b) => b.score - a.score || b.p.popularity - a.p.popularity)
    .map((x) => x.p);
}
