import { fail, ok } from "@/lib/http";
import { getSchedule } from "@/lib/schedule";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok({ schedule: await getSchedule() });
  } catch (err) {
    console.error("schedule failed", err);
    return fail("We couldn't load delivery dates just now.", 500);
  }
}
