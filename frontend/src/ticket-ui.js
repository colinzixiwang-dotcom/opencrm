// Synchronization times use the workspace timezone and never expose raw API dates.
export function syncTimestamp(value, locale, timeZone = "Asia/Shanghai", now = new Date()) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const sameDay = day.format(date) === day.format(now);
  const clock = { timeZone, hour: "2-digit", minute: "2-digit", hour12: false };
  return {
    short: new Intl.DateTimeFormat(locale, { ...clock, ...(sameDay ? {} : { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }) }).format(date),
    full: new Intl.DateTimeFormat(locale, { ...clock, year: "numeric", month: "2-digit", day: "2-digit" }).format(date),
  };
}
