import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { AddressManager } from "@/components/account-ui";
import { db } from "@/db";
import { addresses } from "@/db/schema";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "My addresses" };

export default async function AddressesPage() {
  const user = await requireUser();
  const rows = await db.select().from(addresses).where(eq(addresses.userId, user.id)).orderBy(addresses.id);
  return (
    <div>
      <h1 className="display text-4xl text-forest">My Addresses</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-charcoal/75">Saved addresses can be selected at checkout. Delivery eligibility is always checked against the postcode you choose for each order.</p>
      <div className="mt-8">
        <AddressManager initial={rows.map((a) => ({ id: a.id, label: a.label, line1: a.line1, line2: a.line2, city: a.city, postcode: a.postcode, isDefault: a.isDefault }))} />
      </div>
    </div>
  );
}
