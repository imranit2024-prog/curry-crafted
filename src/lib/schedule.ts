import { and, eq, gt, gte, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { getConfig } from "./config";
import { hourLabel, type FrozenEstimateDTO, type ScheduleDateDTO, type ScheduleDTO } from "./types";

/** Unpaid orders hold their slot for this long before the space is released. */
export const SLOT_HOLD_MINUTES = 30;

export function londonNow(): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function formatDate(date: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(new Date(`${date}T00:00:00Z`));
}

export function slotHoldCondition() {
  return and(
    ne(orders.status, "cancelled"),
    or(eq(orders.paymentStatus, "paid"), gt(orders.createdAt, new Date(Date.now() - SLOT_HOLD_MINUTES * 60000))),
  );
}

export async function getFrozenEstimate(): Promise<FrozenEstimateDTO> {
  const { frozenSchedule: f } = await getConfig();
  const now = londonNow();
  let dispatch = now.date;
  for (let i = 0; i < 21; i++) {
    const d = addDays(now.date, i);
    const pastCutoff = i === 0 && now.hour >= f.cutoffHour;
    if (f.dispatchWeekdays.includes(weekdayOf(d)) && !pastCutoff) {
      dispatch = d;
      break;
    }
  }
  const from = addDays(dispatch, f.transitDaysMin);
  const to = addDays(dispatch, f.transitDaysMax);
  return {
    dispatchDate: dispatch,
    dispatchLabel: formatDate(dispatch, { weekday: "long", day: "numeric", month: "long" }),
    estimateLabel: from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`,
    cutoffLabel: `Order by ${hourLabel(f.cutoffHour)} on ${formatDate(dispatch, { weekday: "long" })} for this dispatch`,
  };
}

export async function getChilledDates(): Promise<ScheduleDateDTO[]> {
  const { chilledSchedule: c } = await getConfig();
  const now = londonNow();

  const booked = await db
    .select({ date: orders.chilledDate, slot: orders.chilledSlotId, count: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(isNotNull(orders.chilledDate), gte(orders.chilledDate, now.date), slotHoldCondition()))
    .groupBy(orders.chilledDate, orders.chilledSlotId);
  const bookedMap = new Map(booked.map((b) => [`${b.date}:${b.slot}`, b.count]));

  const dates: ScheduleDateDTO[] = [];
  for (let i = 0; i <= c.horizonDays && dates.length < 8; i++) {
    const date = addDays(now.date, i);
    if (!c.deliveryWeekdays.includes(weekdayOf(date))) continue;
    const cutoffDate = addDays(date, -c.cutoffDaysBefore);
    const open = now.date < cutoffDate || (now.date === cutoffDate && now.hour < c.cutoffHour);
    dates.push({
      date,
      weekday: formatDate(date, { weekday: "short" }),
      dayLabel: formatDate(date, { day: "numeric", month: "short" }),
      longLabel: formatDate(date, { weekday: "long", day: "numeric", month: "long" }),
      cutoffLabel: `Order by ${hourLabel(c.cutoffHour)} on ${formatDate(cutoffDate, { weekday: "long", day: "numeric", month: "short" })}`,
      open,
      slots: c.slots.map((s) => {
        const remaining = Math.max(0, c.capacityPerSlot - (bookedMap.get(`${date}:${s.id}`) ?? 0));
        return { id: s.id, label: s.label, remaining, available: open && remaining > 0 };
      }),
    });
  }
  return dates;
}

export async function getSchedule(): Promise<ScheduleDTO> {
  const [chilled, frozen] = await Promise.all([getChilledDates(), getFrozenEstimate()]);
  return { chilled, frozen };
}
