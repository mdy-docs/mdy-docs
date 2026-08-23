/*
 * Small date/string utilities shared by the script-defined-site primitive
 * (script-site.js) and, previously, edubba's own conventional content/
 * layouts/site.yaml vault — now removed (every site is a script-defined
 * site; see docs/site-plan.md's "Toward a script-defined site" for why).
 * These three survive because they're genuinely generic, not tied to any
 * site-building convention.
 */

/** Lowercase, non-alphanumerics to single hyphens, trimmed. */
export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalize a front-matter date to the canonical `YYYY-MM-DD` string — the
 * one form that survives the YAML → JSON trip across the VM boundary intact
 * and sorts correctly as a string. Accepts a Date — a host may hand one in,
 * though the YAML parser does not make them: an unquoted date is a string
 * under YAML 1.2 — an ISO-ish string, or `YYYY-MM` (padded to the 1st).
 * Anything else is undefined.
 */
export function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(value.trim());
    if (m) return `${m[1]}-${m[2]}-${m[3] ?? '01'}`;
  }
  return undefined;
}

/** A canonical YYYY-MM-DD date string → RFC 822 (the format RSS pubDate
 * needs). Host-side only — the lamassu VM forbids `new`, so this cannot run
 * inside a template; callers precompute it before rendering, or reach it
 * via the $.rfc822 native (script-site.js). */
export function rfc822(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toUTCString();
}
