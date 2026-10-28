/** Hosted numeric API fields are existing integer ledger units, never displayed Credits. */
export const HOSTED_LEDGER_UNITS_PER_CREDIT = 100;
export function formatCreditUnits(value: string | number | bigint): string {
  const units = BigInt(value);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const fraction = (absolute % 100n)
    .toString()
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${(absolute / 100n).toLocaleString()}${
    fraction ? `.${fraction}` : ''
  }`;
}
export function creditUnitsInput(value: string | number | bigint): string {
  const units = BigInt(value);
  return `${units / 100n}.${(units % 100n)
    .toString()
    .padStart(2, '0')}`.replace(/\.?0+$/, '');
}
export function parseCreditInput(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const units =
    BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return units <= 1_000_000n ? Number(units) : null;
}
