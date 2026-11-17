import { cache } from "react";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { ensureSeeded } from "./seed";
import { DEFAULT_CONFIG } from "./seed-data";
import type { StoreConfig } from "./types";

/** Business rules are stored in the `settings` table so they can be changed without a deploy. */
export const getConfig = cache(async (): Promise<StoreConfig> => {
  await ensureSeeded();
  const rows = await db.select().from(settings);
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const row of rows) {
    if (row.key in DEFAULT_CONFIG) merged[row.key] = row.value;
  }
  return merged as StoreConfig;
});

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
