/**
 * Temporal resolver: turns a structured reference ("last Tuesday", "3 November",
 * "two weeks ago") into concrete UTC time ranges, in the *user's* timezone.
 *
 * The LLM only classifies the phrase; all calendar arithmetic happens here, because
 * models are unreliable at weekday maths and this is the part that must be exact.
 * Ambiguous phrases return several candidates, ordered by preference. Recall then
 * searches all of them and lets the evidence decide, instead of guessing.
 */

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type TemporalRef = {
  /** The phrase as the user wrote it, e.g. "last Tuesday". */
  text: string;
  kind: "weekday" | "calendar_date" | "relative" | "named";
  weekday: Weekday | null;
  qualifier: "last" | "this" | "none" | null;
  month: number | null; // 1-12
  day: number | null;
  year: number | null;
  amount: number | null;
  unit: "day" | "week" | "month" | null;
  name: "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | null;
};

export type ResolvedRange = {
  /** Human label in the user's timezone, e.g. "Tue 3 Nov 2026" or "week of Mon 2 Nov 2026". */
  label: string;
  start: Date; // inclusive, UTC instant
  end: Date; // exclusive, UTC instant
};

export type Resolution = { ref: TemporalRef; candidates: ResolvedRange[]; note?: string };

/** A calendar date with no time or zone attached. */
type Civil = { y: number; m: number; d: number };

// ── timezone primitives ──────────────────────────────────────────────────────

const partsCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partsCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `tz` from UTC at `instant`, in ms (positive east of Greenwich). */
function tzOffsetMs(instant: Date, tz: string): number {
  const p: Record<string, number> = {};
  for (const { type, value } of fmt(tz).formatToParts(instant)) {
    if (type !== "literal") p[type] = Number(value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The calendar date `instant` falls on in `tz`. */
export function civilIn(instant: Date, tz: string): Civil {
  const local = new Date(instant.getTime() + tzOffsetMs(instant, tz));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
}

/** UTC instant of local midnight at the start of `c` in `tz` (DST-safe). */
export function startOfCivil(c: Civil, tz: string): Date {
  const guess = Date.UTC(c.y, c.m - 1, c.d);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  // Re-check once: the offset at the real instant can differ from the guess across a DST edge.
  t = guess - tzOffsetMs(new Date(t), tz);
  return new Date(t);
}

// ── civil arithmetic (pure, zone-free) ───────────────────────────────────────

function addDays(c: Civil, n: number): Civil {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function weekdayOf(c: Civil): number {
  return new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
}
function cmp(a: Civil, b: Civil): number {
  return Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
}
/** Monday of the week containing `c` (ISO weeks: Monday first). */
function mondayOf(c: Civil): Civil {
  return addDays(c, -((weekdayOf(c) + 6) % 7));
}
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function civilLabel(c: Civil): string {
  return `${DOW[weekdayOf(c)]} ${c.d} ${MONTHS[c.m - 1]} ${c.y}`;
}

function dayRange(c: Civil, tz: string, label = civilLabel(c)): ResolvedRange {
  return { label, start: startOfCivil(c, tz), end: startOfCivil(addDays(c, 1), tz) };
}
function spanRange(from: Civil, toExclusive: Civil, tz: string, label: string): ResolvedRange {
  return { label, start: startOfCivil(from, tz), end: startOfCivil(toExclusive, tz) };
}

// ── resolution ───────────────────────────────────────────────────────────────

export function resolveRef(ref: TemporalRef, now: Date, tz: string): Resolution {
  const today = civilIn(now, tz);
  const candidates: ResolvedRange[] = [];
  let note: string | undefined;

  switch (ref.kind) {
    case "weekday": {
      const target = WEEKDAYS.indexOf((ref.weekday ?? "monday") as Weekday);
      const back = (weekdayOf(today) - target + 7) % 7; // 0 = today
      const mostRecentPast = addDays(today, back === 0 ? -7 : -back);
      const thisWeekOcc = addDays(mondayOf(today), (target + 6) % 7);
      const lastWeekOcc = addDays(thisWeekOcc, -7);

      if (ref.qualifier === "last") {
        // "Last Tuesday" is genuinely ambiguous when that day already happened this week:
        // some people mean the most recent one, others the one in the previous week.
        if (cmp(mostRecentPast, mondayOf(today)) >= 0) {
          candidates.push(dayRange(lastWeekOcc, tz), dayRange(mostRecentPast, tz));
          note = "ambiguous: 'last <weekday>' could mean the previous week's or the most recent one";
        } else {
          candidates.push(dayRange(mostRecentPast, tz));
        }
      } else if (ref.qualifier === "this") {
        if (cmp(thisWeekOcc, today) <= 0) candidates.push(dayRange(thisWeekOcc, tz));
        else candidates.push(dayRange(mostRecentPast, tz));
      } else {
        // Bare "on Monday" in a question about the past: today if it *is* Monday, else the latest one.
        if (back === 0) candidates.push(dayRange(today, tz), dayRange(addDays(today, -7), tz));
        else candidates.push(dayRange(mostRecentPast, tz));
      }
      break;
    }

    case "calendar_date": {
      const m = ref.month ?? today.m;
      const d = ref.day ?? 1;
      let y = ref.year ?? today.y;
      if (ref.year == null && cmp({ y, m, d }, today) > 0) y -= 1; // "3 November" said in October = last year
      if (d < 1 || d > daysInMonth(y, m)) {
        note = `invalid date: ${y}-${m}-${d}`;
        break;
      }
      candidates.push(dayRange({ y, m, d }, tz));
      break;
    }

    case "relative": {
      const n = Math.max(0, ref.amount ?? 1);
      if (ref.unit === "week") {
        const mon = mondayOf(addDays(today, -7 * n));
        candidates.push(spanRange(mon, addDays(mon, 7), tz, `week of ${civilLabel(mon)}`));
      } else if (ref.unit === "month") {
        let y = today.y;
        let m = today.m - n;
        while (m < 1) { m += 12; y -= 1; }
        candidates.push(monthRange(y, m, tz));
      } else {
        const day = addDays(today, -n);
        // "3 days ago" is fuzzy in everyday speech: try the exact day, then ±1.
        candidates.push(dayRange(day, tz), dayRange(addDays(day, -1), tz), dayRange(addDays(day, 1), tz));
      }
      break;
    }

    case "named": {
      const mon = mondayOf(today);
      switch (ref.name) {
        case "today": candidates.push(dayRange(today, tz)); break;
        case "yesterday": candidates.push(dayRange(addDays(today, -1), tz)); break;
        case "this_week": candidates.push(spanRange(mon, addDays(today, 1), tz, `this week (from ${civilLabel(mon)})`)); break;
        case "last_week": candidates.push(spanRange(addDays(mon, -7), mon, tz, `last week (${civilLabel(addDays(mon, -7))} – ${civilLabel(addDays(mon, -1))})`)); break;
        case "this_month": candidates.push(monthRange(today.y, today.m, tz)); break;
        case "last_month": {
          const y = today.m === 1 ? today.y - 1 : today.y;
          const m = today.m === 1 ? 12 : today.m - 1;
          candidates.push(monthRange(y, m, tz));
          break;
        }
        default: note = "unknown named period";
      }
      break;
    }
  }

  return { ref, candidates, note };
}

function monthRange(y: number, m: number, tz: string): ResolvedRange {
  const first = { y, m, d: 1 };
  const next = m === 12 ? { y: y + 1, m: 1, d: 1 } : { y, m: m + 1, d: 1 };
  return spanRange(first, next, tz, `${MONTHS[m - 1]} ${y}`);
}

/** "Wed 11 Nov 2026, 14:05 (Europe/London)" — what the model is told "now" is. */
export function describeNow(now: Date, tz: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return `${civilLabel(civilIn(now, tz))}, ${time} (${tz})`;
}

/** Local label for a stored instant, e.g. "Tue 3 Nov 2026, 10:12". */
export function describeInstant(instant: Date, tz: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
  return `${civilLabel(civilIn(instant, tz))}, ${time}`;
}

/** ISO calendar date (YYYY-MM-DD) of an instant in `tz`, for search date filters. */
export function isoDateIn(instant: Date, tz: string): string {
  const c = civilIn(instant, tz);
  return `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
}
