import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { CheckoutFlow } from "@/components/checkout-flow";
import { db } from "@/db";
import { addresses } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getConfig, stripeConfigured } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Secure checkout" };

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<{ payment?: string }> }) {
  const sp = await searchParams;
  const [user, config] = await Promise.all([getCurrentUser(), getConfig()]);
  const saved = user ? await db.select().from(addresses).where(eq(addresses.userId, user.id)).orderBy(addresses.id) : [];
  return (
    <section className="container-x py-8 md:py-12">
      <h1 className="display text-[clamp(2.2rem,4.5vw,3.5rem)] text-forest">Checkout</h1>
      <div className="mt-8">
        <CheckoutFlow
          stripeEnabled={stripeConfigured()}
          guestCheckout={config.guestCheckout}
          paymentCancelled={sp.payment === "cancelled"}
          savedAddresses={saved.map((a) => ({ id: a.id, label: a.label, line1: a.line1, line2: a.line2, city: a.city, postcode: a.postcode, isDefault: a.isDefault }))}
        />
      </div>
    </section>
  );
}
