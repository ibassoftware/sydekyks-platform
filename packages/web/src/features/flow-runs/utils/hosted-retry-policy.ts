import { FlowRun, FlowRunStatus } from '@activepieces/shared';

export function canRerunHostedRun(
  run: Pick<FlowRun, 'status' | 'parentRunId' | 'stepNameToTest'>,
) {
  return (
    run.status === FlowRunStatus.FAILED &&
    !run.parentRunId &&
    !run.stepNameToTest
  );
}

export function hostedRetryErrorMessage(code: string): string {
  if (code.includes('PRIOR_WORK_UNRESOLVED')) {
    return 'An earlier attempt still needs a confirmed outcome. Wait for it to finish or contact support before rerunning.';
  }
  if (code.includes('PAYER_CHANGED')) {
    return 'The AI billing choice changed. Restore the original Sydekyks or BYOK selection before rerunning, or start a new run.';
  }
  if (code.includes('CREDITS') || code.includes('ALLOWANCE')) {
    return 'There are not enough Credits for this run. Check your balance and any Credits held by pending runs.';
  }
  if (code.includes('EXPIRED')) {
    return 'Workspace access has expired. Contact your administrator or Sydekyks to renew access.';
  }
  return 'This run could not be restarted. Only completed failed workflows can be rerun. Check workspace access and contact support if the earlier attempt needs review.';
}
