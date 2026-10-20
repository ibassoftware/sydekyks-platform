import { ApFlagId } from '@activepieces/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useFlag } = vi.hoisted(() => ({ useFlag: vi.fn() }));
vi.mock('@/hooks/flags-hooks', () => ({ flagsHooks: { useFlag } }));

import { useHostedBillingEnabled } from './service-mode';

beforeEach(() => useFlag.mockReset());

describe('hosted billing stays opt in for self-hosted installations', () => {
  it.each([undefined, null, 'self_hosted', '', 'HOSTED', ' hosted', 'unknown'])(
    'hides hosted billing for service mode %s',
    (mode) => {
      useFlag.mockReturnValue({ data: mode });
      expect(useHostedBillingEnabled()).toBe(false);
      expect(useFlag).toHaveBeenCalledWith(ApFlagId.SERVICE_MODE);
    }
  );

  it('enables hosted billing only for an explicit server declaration', () => {
    useFlag.mockReturnValue({ data: 'hosted' });
    expect(useHostedBillingEnabled()).toBe(true);
  });
});
