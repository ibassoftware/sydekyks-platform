import {
  ApFlagId,
  HOSTED_RUNTIME_CAPABILITIES,
  HOSTED_RUNTIME_PROFILE,
} from '@activepieces/shared';

import { flagsHooks } from '@/hooks/flags-hooks';

// Older servers have no flag. Only an explicit hosted installation opts in.
export function useHostedBillingEnabled() {
  return flagsHooks.useFlag<string>(ApFlagId.SERVICE_MODE).data === 'hosted';
}

export function hostedRuntimeReady(flags: Record<string, unknown>) {
  const capabilities = flags[ApFlagId.HOSTED_RUNTIME_CAPABILITIES];
  return (
    flags[ApFlagId.HOSTED_RUNTIME_PROFILE] === HOSTED_RUNTIME_PROFILE &&
    Array.isArray(capabilities) &&
    capabilities.length === HOSTED_RUNTIME_CAPABILITIES.length &&
    HOSTED_RUNTIME_CAPABILITIES.every((value) => capabilities.includes(value))
  );
}

export function useHostedRuntimeReady() {
  return hostedRuntimeReady(flagsHooks.useFlags().data);
}
