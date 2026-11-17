import { db } from "@/db";
import { chilledPostcodes, frozenRestrictions } from "@/db/schema";
import { ensureSeeded } from "./seed";
import type { PostcodeResult } from "./types";

export const POSTCODE_COOKIE = "cc_postcode";

const UK_POSTCODE = /^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z]{2})$/;

export function parsePostcode(raw: string): { outward: string; inward: string; area: string; formatted: string } | null {
  const compact = String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const match = UK_POSTCODE.exec(compact);
  if (!match) return null;
  const outward = match[1];
  const inward = match[2];
  const area = /^[A-Z]+/.exec(outward)![0];
  return { outward, inward, area, formatted: `${outward} ${inward}` };
}

export type PostcodeCheck = { valid: false; error: string } | ({ valid: true } & PostcodeResult);

/**
 * Delivery eligibility engine.
 * - Chilled: only postcodes whose outward code (or whole area) is in `chilled_postcodes`.
 * - Frozen: UK-wide unless the area/outward code is listed in `frozen_restrictions`.
 */
export async function checkPostcode(raw: string): Promise<PostcodeCheck> {
  if (!raw || !String(raw).trim()) return { valid: false, error: "Enter a postcode to check delivery." };
  const parsed = parsePostcode(raw);
  if (!parsed) return { valid: false, error: "That doesn't look like a full UK postcode. Try something like DY9 8DU." };

  await ensureSeeded();
  const [chilledRows, frozenRows] = await Promise.all([db.select().from(chilledPostcodes), db.select().from(frozenRestrictions)]);
  const matches = (prefix: string) => prefix === parsed.outward || prefix === parsed.area;

  const chilled = chilledRows.some((r) => r.active && matches(r.prefix.toUpperCase()));
  // Prefer the most specific rule (outward code beats area).
  const restriction =
    frozenRows.find((r) => r.prefix.toUpperCase() === parsed.outward) ?? frozenRows.find((r) => r.prefix.toUpperCase() === parsed.area);

  return {
    valid: true,
    postcode: parsed.formatted,
    outward: parsed.outward,
    chilled,
    frozen: restriction?.kind !== "excluded",
    frozenSurchargePence: restriction?.kind === "surcharge" ? restriction.surchargePence : 0,
    frozenNote: restriction?.note || null,
  };
}

export function toResult(check: PostcodeCheck): PostcodeResult | null {
  if (!check.valid) return null;
  const { postcode, outward, chilled, frozen, frozenSurchargePence, frozenNote } = check;
  return { postcode, outward, chilled, frozen, frozenSurchargePence, frozenNote };
}
