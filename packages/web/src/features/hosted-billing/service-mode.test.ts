import {
  ApFlagId,
  HOSTED_RUNTIME_CAPABILITIES,
  HOSTED_RUNTIME_PROFILE,
} from '@activepieces/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useFlag } = vi.hoisted(() => ({ useFlag: vi.fn() }));
vi.mock('@/hooks/flags-hooks', () => ({ flagsHooks: { useFlag } }));

import { hostedRuntimeReady, useHostedBillingEnabled } from './service-mode';

beforeEach(() => useFlag.mockReset());

describe('hosted billing stays opt in for self-hosted installations', () => {
  it.each([undefined, null, 'self_hosted', '', 'HOSTED', ' hosted', 'unknown'])(
    'hides hosted billing for service mode %s',
    (mode) => {
      useFlag.mockReturnValue({ data: mode });
      expect(useHostedBillingEnabled()).toBe(false);
      expect(useFlag).toHaveBeenCalledWith(ApFlagId.SERVICE_MODE);
    },
  );

  it('enables hosted billing only for an explicit server declaration', () => {
    useFlag.mockReturnValue({ data: 'hosted' });
    expect(useHostedBillingEnabled()).toBe(true);
  });

  it('requires the exact current execution contract before showing restored hosted capabilities', () => {
    const flags = {
      [ApFlagId.HOSTED_RUNTIME_PROFILE]: HOSTED_RUNTIME_PROFILE,
      [ApFlagId.HOSTED_RUNTIME_CAPABILITIES]: [...HOSTED_RUNTIME_CAPABILITIES],
    };
    expect(hostedRuntimeReady(flags)).toBe(true);
    expect(hostedRuntimeReady({})).toBe(false);
    expect(
      hostedRuntimeReady({
        ...flags,
        [ApFlagId.HOSTED_RUNTIME_PROFILE]: 'partner-pilot-v1',
      }),
    ).toBe(false);
    expect(
      hostedRuntimeReady({
        ...flags,
        [ApFlagId.HOSTED_RUNTIME_CAPABILITIES]:
          HOSTED_RUNTIME_CAPABILITIES.slice(1),
      }),
    ).toBe(false);
    expect(
      hostedRuntimeReady({
        ...flags,
        [ApFlagId.HOSTED_RUNTIME_CAPABILITIES]: [
          ...HOSTED_RUNTIME_CAPABILITIES,
          'future',
        ],
      }),
    ).toBe(false);
  });
});
