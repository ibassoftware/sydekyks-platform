// Source authority still expires after ten minutes. The refresh margin covers
// the 65-second quote requirement, ten-second HTTP deadline and 15 seconds of
// ordinary scheduling delay. It does not extend authority during outages/stalls.
export const PRICING_FRESH_MS = 10 * 60_000
export const PRICING_REFRESH_MS = 5 * 60_000
export const PRICING_HTTP_DEADLINE_MS = 10_000
export const PRICING_MIN_REFRESH_VALIDITY_MS = PRICING_REFRESH_MS + 90_000
