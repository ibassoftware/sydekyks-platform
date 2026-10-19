export const SUBSCRIPTION_GRACE_MS = 15 * 24 * 60 * 60 * 1000;

// datetime-local deliberately represents UTC here, regardless of browser timezone.
export function subscriptionUtcInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value))
    return null;
  const date = new Date(value + 'Z');
  if (
    !Number.isFinite(date.getTime()) ||
    date.getTime() < Date.parse('2000-01-01T00:00:00Z') ||
    date.getTime() > Date.parse('9998-12-01T00:00:00Z')
  )
    return null;
  const iso = date.toISOString();
  if (iso.slice(0, 16) !== value.slice(0, 16)) return null;
  if (value.length >= 19 && iso.slice(0, 19) !== value.slice(0, 19))
    return null;
  return iso;
}
export function subscriptionGraceEnd(renewalDueAt: string): string | null {
  const date = new Date(Date.parse(renewalDueAt) + SUBSCRIPTION_GRACE_MS);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999)
    return null;
  return date.toISOString();
}
export function subscriptionUtcLabel(value: string): string {
  return value
    .replace('T', ' ')
    .replace(/\.000Z$/, ' UTC')
    .replace(/Z$/, ' UTC');
}
