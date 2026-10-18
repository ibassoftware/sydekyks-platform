import { ApFlagId } from '@activepieces/shared';

import { api } from '@/lib/api';

export type FlagsMap = Record<string, boolean | string | object | undefined>;
export const flagsApi = {
  async getAll() {
    const flags = await api.get<FlagsMap>(`/v1/flags`);
    // Install before the suspended application starts any private queries.
    api.setHostedSessionIsolation(flags[ApFlagId.SERVICE_MODE] === 'hosted');
    return flags;
  },
};
