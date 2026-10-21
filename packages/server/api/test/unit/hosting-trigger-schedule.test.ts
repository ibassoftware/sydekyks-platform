import { TriggerSourceScheduleType } from '@activepieces/shared'
import { describe, expect, it } from 'vitest'
import { hostedTriggerSchedule } from '../../src/app/hosting/hosting-trigger-schedule'
const cron = (cronExpression: string, timezone = 'UTC') => ({ type: TriggerSourceScheduleType.CRON_EXPRESSION as const, cronExpression, timezone })
describe('hosted trigger schedule limits', () => {
    it('keeps minute-or-slower intervals and calendar schedules', () => {
        expect(hostedTriggerSchedule({ type: TriggerSourceScheduleType.INTERVAL, intervalMs: 60000 })).toEqual({ type: TriggerSourceScheduleType.INTERVAL, intervalMs: 60000 })
        for (const expression of ['* * * * *', '0 * * * * *', '@daily']) expect(hostedTriggerSchedule(cron(expression))).toEqual(cron(expression))
    })
    it('refuses sub-minute cadence and invalid zones before scheduler registration', () => {
        expect(() => hostedTriggerSchedule({ type: TriggerSourceScheduleType.INTERVAL, intervalMs: 1000 })).toThrow('HOSTING_TRIGGER_SCHEDULE_INVALID')
        for (const expression of ['* * * * * *', '*/5 * * * * *', '0,30 * * * * *']) expect(() => hostedTriggerSchedule(cron(expression))).toThrow('HOSTING_TRIGGER_SCHEDULE_INVALID')
        expect(() => hostedTriggerSchedule(cron('0 * * * *', 'unknown/zone'))).toThrow('HOSTING_TRIGGER_SCHEDULE_INVALID')
    })
})
