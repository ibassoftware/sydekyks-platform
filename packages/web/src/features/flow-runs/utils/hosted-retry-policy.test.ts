import { FlowRunStatus } from '@activepieces/shared';
import { describe, expect, it } from 'vitest';

import {
  canRerunHostedRun,
  hostedRetryErrorMessage,
} from './hosted-retry-policy';

describe('hosted rerun affordance', () => {
  it('offers a complete rerun only for failed root workflows', () => {
    expect(canRerunHostedRun({ status: FlowRunStatus.FAILED })).toBe(true);
    for (const status of [
      FlowRunStatus.RUNNING,
      FlowRunStatus.QUEUED,
      FlowRunStatus.INTERNAL_ERROR,
      FlowRunStatus.SUCCEEDED,
      FlowRunStatus.PAUSED,
    ]) {
      expect(canRerunHostedRun({ status })).toBe(false);
    }
    expect(
      canRerunHostedRun({ status: FlowRunStatus.FAILED, parentRunId: 'parent' })
    ).toBe(false);
    expect(
      canRerunHostedRun({ status: FlowRunStatus.FAILED, stepNameToTest: 'ai' })
    ).toBe(false);
  });

  it('explains uncertain liability and BYOK changes without exposing internal codes', () => {
    expect(
      hostedRetryErrorMessage('HOSTING_RETRY_PRIOR_WORK_UNRESOLVED')
    ).toContain('confirmed outcome');
    expect(hostedRetryErrorMessage('HOSTING_RETRY_PAYER_CHANGED')).toContain(
      'BYOK'
    );
    expect(
      hostedRetryErrorMessage('HOSTING_EXECUTION_CREDITS_EXCEEDED')
    ).toContain('not enough Credits');
    expect(hostedRetryErrorMessage('HOSTING_ENTITLEMENT_EXPIRED')).toContain(
      'renew access'
    );
  });
});
