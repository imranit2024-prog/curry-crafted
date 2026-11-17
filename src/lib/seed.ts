import { sql } from "drizzle-orm";
import { db } from "@/db";
import { bundles, chilledPostcodes, frozenRestrictions, products, promoCodes, settings } from "@/db/schema";
import { CHILLED_POSTCODE_PREFIXES, DEFAULT_CONFIG, FROZEN_RESTRICTIONS, PROMO_CODES, SEED_BUNDLES, SEED_PRODUCTS } from "./seed-data";

const g = globalThis as typeof globalThis & { __ccSeedPromise?: Promise<void> };

async function seed() {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(products);
  if (count > 0) return;
  await db.insert(products).values(SEED_PRODUCTS).onConflictDoNothing();
  await db.insert(bundles).values(SEED_BUNDLES).onConflictDoNothing();
  await db
    .insert(chilledPostcodes)
    .values(CHILLED_POSTCODE_PREFIXES.map((prefix) => ({ prefix })))
    .onConflictDoNothing();
  await db.insert(frozenRestrictions).values(FROZEN_RESTRICTIONS).onConflictDoNothing();
  await db.insert(promoCodes).values(PROMO_CODES).onConflictDoNothing();
  await db
    .insert(settings)
    .values(Object.entries(DEFAULT_CONFIG).map(([key, value]) => ({ key, value: value as unknown })))
    .onConflictDoNothing();
}

/** Seeds an empty database with the placeholder catalogue and business rules (idempotent). */
export function ensureSeeded(): Promise<void> {
  if (!g.__ccSeedPromise) {
    g.__ccSeedPromise = seed().catch((err) => {
      g.__ccSeedPromise = undefined;
      throw err;
    });
  }
  return g.__ccSeedPromise;
}
