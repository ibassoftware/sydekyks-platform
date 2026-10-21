import { ScheduleOptions, TriggerSourceScheduleType } from '@activepieces/shared'
import { hostingFail } from './hosting-transactions'

// Polling and renewal may run at most once per minute. Queue registration is
// not an execution admission; every occurrence still acquires its own fence.
export function hostedTriggerSchedule(value: ScheduleOptions): ScheduleOptions {
    const result = ScheduleOptions.safeParse(value)
    if (!result.success) hostingFail('HOSTING_TRIGGER_SCHEDULE_INVALID')
    const schedule = result.data
    if (schedule.type === TriggerSourceScheduleType.INTERVAL) return schedule
    if (schedule.cronExpression.length > 256 || schedule.timezone.length > 100) hostingFail('HOSTING_TRIGGER_SCHEDULE_INVALID')
    const fields = schedule.cronExpression.trim().split(/\s+/)
    const alias = fields.length === 1 && /^@(hourly|daily|weekly|monthly|yearly|annually)$/.test(fields[0])
    if (!alias && fields.length !== 5 && !(fields.length === 6 && /^[0-5]?\d$/.test(fields[0]))) hostingFail('HOSTING_TRIGGER_SCHEDULE_INVALID')
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone }).format() 
    }
    catch {
        hostingFail('HOSTING_TRIGGER_SCHEDULE_INVALID') 
    }
    return schedule
}
