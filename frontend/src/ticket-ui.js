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

export function ticketNumberQuery(value) {
  const match = value.trim().match(/^#?(\d{1,20})$/);
  return match ? match[1] : null;
}

// Match known API failures; never render raw server errors as customer-facing copy.
export function ticketListIssue(error) {
  if (!error) return null;
  if (error.status === 401) return "session";
  if (error.status === 403) {
    if (error.message === "This Udesk filter is not available to your account.") return "filter";
    if (error.message === "Your account is not mapped to an active Udesk agent.") return "mapping";
    return "permission";
  }
  return "unavailable";
}
