import { describe, expect, it } from 'vitest';

import {
  creditUnitsInput,
  formatCreditUnits,
  parseCreditInput,
} from '../../src/lib/hosted-credit-units';
describe('hosted displayed Credits retain integer accounting', () => {
  it('shows historical balances, holds and limits without changing storage', () => {
    expect(formatCreditUnits('1')).toBe('0.01');
    expect(formatCreditUnits('500')).toBe('5');
    expect(formatCreditUnits('10000')).toBe('100');
    expect(formatCreditUnits('99842')).toBe('998.42');
    expect(formatCreditUnits('91')).toBe('0.91');
    expect(formatCreditUnits('900719925474099301')).toBe(
      '9,007,199,254,740,993.01',
    );
  });
  it('round trips saved limits exactly and rejects finer fractions/unsafe values', () => {
    for (const units of [0, 1, 99, 100, 500, 30000, 120000, 400000, 1000000]) {
      expect(parseCreditInput(creditUnitsInput(units))).toBe(units);
    }
    for (const value of [
      '',
      '0.001',
      '-1',
      'NaN',
      '1e3',
      '10000.01',
      '900719925474099301',
    ])
      expect(parseCreditInput(value)).toBeNull();
    expect(parseCreditInput('300.01')).toBe(30001);
  });
});
