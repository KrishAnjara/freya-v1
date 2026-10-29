const TIME_ZONES: Record<string, string> = {
  india: "Asia/Kolkata",
  mumbai: "Asia/Kolkata",
  delhi: "Asia/Kolkata",
  tokyo: "Asia/Tokyo",
  japan: "Asia/Tokyo",
  london: "Europe/London",
  uk: "Europe/London",
  "united kingdom": "Europe/London",
  paris: "Europe/Paris",
  france: "Europe/Paris",
  berlin: "Europe/Berlin",
  germany: "Europe/Berlin",
  "new york": "America/New_York",
  "los angeles": "America/Los_Angeles",
  chicago: "America/Chicago",
  "san francisco": "America/Los_Angeles",
  "united states": "America/New_York",
  usa: "America/New_York",
  toronto: "America/Toronto",
  vancouver: "America/Vancouver",
  sydney: "Australia/Sydney",
  australia: "Australia/Sydney",
  dubai: "Asia/Dubai",
  singapore: "Asia/Singapore",
  "hong kong": "Asia/Hong_Kong",
  seoul: "Asia/Seoul",
  "south korea": "Asia/Seoul",
  bangkok: "Asia/Bangkok",
  jakarta: "Asia/Jakarta",
  auckland: "Pacific/Auckland",
  "new zealand": "Pacific/Auckland",
  "cape town": "Africa/Johannesburg",
  nairobi: "Africa/Nairobi",
  "saudi arabia": "Asia/Riyadh",
  riyadh: "Asia/Riyadh",
  utc: "UTC",
  gmt: "Etc/GMT",
};

export function getTimeInZone(timeZoneInput: string, at: Date = new Date()): {
  timeZone: string;
  date: string;
  time: string;
  offset: string;
} {
  const input = timeZoneInput.trim().toLowerCase();

  const timeZone = TIME_ZONES[input] || timeZoneInput.trim();

  // Throws RangeError if the supplied IANA timezone is invalid.
  const now = at;

  const date = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);

  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(now);

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(now);

  const offset =
    parts.find((part) => part.type === "timeZoneName")?.value ||
    "Unknown offset";

  return { timeZone, date, time, offset };
}

export function findTimeZone(text: string): string | null {
  const input = text.trim();

  // Allow explicit IANA zones such as Europe/Paris.
  const iana = input.match(/\b([A-Za-z_]+\/[A-Za-z0-9_+\-/]+)\b/);

  if (iana) {
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: iana[1],
      });
      return iana[1];
    } catch {
      // Continue with city and country aliases.
    }
  }

  const lower = input.toLowerCase();

  const aliases = Object.keys(TIME_ZONES).sort((a, b) => b.length - a.length);

  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    if (new RegExp(`\\b${escaped}\\b`, "i").test(lower)) {
      return TIME_ZONES[alias];
    }
  }

  return null;
}

export function isTimeQuestion(text: string): boolean {
  const value = text.trim().toLowerCase();

  return (
    /\b(what time is it|current time|local time|time right now|date and time|current date|today'?s date|what day is it|what is the date)\b/i.test(
      value,
    ) ||
    /\btime\s+(in|at)\s+[a-z]/i.test(value) ||
    /\bdate\s+(in|at)\s+[a-z]/i.test(value) ||
    /\bwhat time\b/i.test(value) ||
    /\btime\s+zone\b/i.test(value)
  );
}
