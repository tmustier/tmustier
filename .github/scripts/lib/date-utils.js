function getZonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) =>
    Number.parseInt(parts.find((part) => part.type === type).value, 10);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function getOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const tzPart = parts.find((part) => part.type === "timeZoneName")?.value || "";
  const match = tzPart.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1].startsWith("-") ? -1 : 1;
  return (
    sign *
    (Math.abs(parseInt(match[1], 10)) * 60 + (parseInt(match[2], 10) || 0))
  );
}

function getZonedStartOfDay(date, timeZone) {
  const { year, month, day } = getZonedDateParts(date, timeZone);
  const baseUtc = Date.UTC(year, month - 1, day);
  let utcMs = baseUtc;
  for (let i = 0; i < 2; i++) {
    const adjusted = baseUtc - getOffsetMinutes(new Date(utcMs), timeZone) * 60000;
    if (adjusted === utcMs) break;
    utcMs = adjusted;
  }
  return new Date(utcMs);
}

function getZonedEndOfDay(date, timeZone) {
  const { year, month, day } = getZonedDateParts(date, timeZone);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1, 12));
  return new Date(getZonedStartOfDay(nextDay, timeZone).getTime() - 1);
}

module.exports = {
  getOffsetMinutes,
  getZonedDateParts,
  getZonedEndOfDay,
  getZonedStartOfDay,
};
