import { describe, expect, it } from 'vitest';

import {
  subscriptionGraceEnd,
  subscriptionUtcInput,
  subscriptionUtcLabel,
} from './subscription-dates';

describe('operator UTC renewal dates', () => {
  it('treats datetime-local as UTC and preserves saved millisecond precision', () => {
    expect(subscriptionUtcInput('2026-10-19T12:30')).toBe(
      '2026-10-19T12:30:00.000Z',
    );
    expect(subscriptionUtcInput('2026-10-19T12:30:45.321')).toBe(
      '2026-10-19T12:30:45.321Z',
    );
  });
  it('rejects invalid rolled-over dates and browser timezone offsets', () => {
    for (const input of [
      '',
      '2026-02-30T12:00',
      '2026-10-19T24:30',
      '2026-10-19T12:00+08:00',
      'tomorrow',
    ])
      expect(subscriptionUtcInput(input)).toBeNull();
  });
  it('adds exactly fifteen24-hour UTC days across a DST transition', () => {
    const due = '2026-10-19T12:30:45.321Z';
    const cutoff = subscriptionGraceEnd(due)!;
    expect(cutoff).toBe('2026-11-03T12:30:45.321Z');
    expect(Date.parse(cutoff) - Date.parse(due)).toBe(15 * 24 * 60 * 60 * 1000);
    expect(subscriptionUtcLabel(cutoff)).toBe('2026-11-03 12:30:45.321 UTC');
  });
  it('does not preview an unserializable cutoff beyond the supported ISO range', () => {
    expect(subscriptionGraceEnd('9999-12-31T00:00:00.000Z')).toBeNull();
  });
});
