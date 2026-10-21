import { ErrorCode } from '@activepieces/core-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  error: {
    isAxiosError: true,
    response: { status: 401, data: { code: 'INVALID_BEARER_TOKEN' } },
  },
}));
vi.mock('axios', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  default: vi.fn(async () => {
    throw state.error;
  }),
  isAxiosError: (error: unknown) => error === state.error,
}));
vi.mock('@/lib/chat-debug-logger', () => ({
  chatDebug: { isEnabled: () => false },
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: {
    getToken: () => 'old-token',
    getProjectId: () => null,
    logOut: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { authenticationSession } from '@/lib/authentication-session';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('public checkout selection during automatic credential expiry', () => {
  it.each([ErrorCode.INVALID_BEARER_TOKEN, ErrorCode.SESSION_EXPIRED])(
    'preserves selection while rejecting invalid credentials (%s)',
    async (code) => {
      state.error.response.data.code = code;
      vi.stubGlobal('window', { location: { href: '/' } });
      await expect(api.get('/v1/flags')).rejects.toBe(state.error);
      expect(authenticationSession.logOut).toHaveBeenCalledWith({
        preserveCheckoutIntent: true,
      });
      expect(window.location.href).toBe('/sign-in');
    },
  );
});
