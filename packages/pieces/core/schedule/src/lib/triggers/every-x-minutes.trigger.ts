import {
  Property,
  TriggerStrategy,
  createTrigger,
} from '@activepieces/pieces-framework';

export const everyXMinutesTrigger = createTrigger({
  name: 'every_x_minutes',
  classification: 'READ',
  displayName: 'Every X Minutes',
  description: 'Triggers the current flow every X minutes',
  aiMetadata: {
    description:
      'Fires repeatedly on a fixed minute interval (a whole number of minutes, 15-59), so each event simply represents "the interval elapsed" rather than any external change. Pick this for sub-hourly recurrence; use Every Hour / Every Day / Every Week / Every Month for coarser fixed schedules, or Cron Expression when the cadence needs specific minutes, weekdays or a timezone. Runs on a plain interval with no timezone or weekday awareness, so it also fires on weekends and overnight.',
  },
  type: TriggerStrategy.POLLING,
  sampleData: {},
  props: {
    minutes: Property.StaticDropdown({
      displayName: 'Minutes',
      description: 'Choose a whole number from 15 to 59 minutes.',
      required: true,
      defaultValue: 15,
      options: {
        disabled: false,
        options: Array.from({ length: 45 }, (_, index) => ({
          label: `${index + 15} minutes`,
          value: index + 15,
        })),
      },
    }),
  },
  onEnable: async (ctx) => {
    const minutes = validateMinutes(ctx.propsValue.minutes);
    ctx.setSchedule({
      intervalMs: minutes * 60_000,
    });
  },
  run(ctx) {
    const minutes = validateMinutes(ctx.propsValue.minutes);
    const cronExpression = `*/${minutes} * * * *`;
    return Promise.resolve([
      {
        cron_expression: cronExpression,
        timezone: 'UTC',
      },
    ]);
  },
  onDisable: async () => {
    console.log('onDisable');
  },
});

function validateMinutes(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 59) {
    throw new Error('Minutes must be a whole number from 15 to 59.');
  }
  return minutes;
}
