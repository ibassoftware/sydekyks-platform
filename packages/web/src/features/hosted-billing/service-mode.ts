import { ApFlagId } from '@activepieces/shared';

import { flagsHooks } from '@/hooks/flags-hooks';

// Older servers have no flag. Only an explicit hosted installation opts in.
export function useHostedBillingEnabled() {
  return flagsHooks.useFlag<string>(ApFlagId.SERVICE_MODE).data === 'hosted';
}
