/// <reference types="vitest/globals" />

import { createMockPollingTriggerContext } from '@activepieces/pieces-framework';
import { everyXMinutesTrigger } from '../src/lib/triggers/every-x-minutes.trigger';

describe('everyXMinutesTrigger', () => {
  test('defaults to 15 minutes and offers no shorter cadence', () => {
    expect(everyXMinutesTrigger.props.minutes.defaultValue).toBe(15);
    const choices = everyXMinutesTrigger.props.minutes.options.options.map(option => option.value);
    expect(Math.min(...choices)).toBe(15);
    expect(Math.max(...choices)).toBe(59);
  });
  test.each([0, 1, 14, 14.5, 60, NaN, Infinity])('rejects invalid minutes %s before scheduling', async minutes => {
    const schedules: unknown[] = [];
    const ctx = createMockPollingTriggerContext({ propsValue: { minutes }, onSetSchedule: schedule => schedules.push(schedule) });
    await expect(everyXMinutesTrigger.onEnable(ctx)).rejects.toThrow('15 to 59');
    expect(() => everyXMinutesTrigger.run(ctx)).toThrow('15 to 59');
    expect(schedules).toEqual([]);
  });
  test('schedules a rolling 59-minute interval instead of a */59 cron', async () => {
    const schedules: unknown[] = [];
    const ctx = createMockPollingTriggerContext({
      propsValue: { minutes: 59 },
      onSetSchedule: (schedule) => schedules.push(schedule),
    });

    await everyXMinutesTrigger.onEnable(ctx);

    expect(schedules).toEqual([{ intervalMs: 59 * 60_000 }]);
  });

  test('schedules divisor values as intervals too', async () => {
    const schedules: unknown[] = [];
    const ctx = createMockPollingTriggerContext({
      propsValue: { minutes: 15 },
      onSetSchedule: (schedule) => schedules.push(schedule),
    });

    await everyXMinutesTrigger.onEnable(ctx);

    expect(schedules).toEqual([{ intervalMs: 15 * 60_000 }]);
  });
});
