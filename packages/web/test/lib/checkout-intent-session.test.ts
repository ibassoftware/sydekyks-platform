/** @vitest-environment jsdom */
import { AuthenticationResponse } from '@activepieces/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selected = vi.hoisted(() => ({ present: true }));
vi.mock('@/lib/checkout-intent', () => ({
  checkoutIntent: {
    clear: vi.fn(() => {
      selected.present = false;
    }),
    billingPath: () => (selected.present ? '/platform/billing' : null),
  },
}));
vi.mock('@/app/query-client', () => ({
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock('@/api/authentication-api', () => ({ authenticationApi: {} }));
vi.mock('@/lib/telemetry-utils', () => ({
  telemetryUtils: { resetIdentity: vi.fn() },
}));

import { authenticationSession } from '@/lib/authentication-session';
import { checkoutIntent } from '@/lib/checkout-intent';

beforeEach(() => {
  localStorage.clear();
  selected.present = true;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('checkout selection during authentication', () => {
  it('keeps the public offer after automatic expired-session logout, then resumes login', () => {
    const dispatchEvent = window.dispatchEvent.bind(window);
    vi.stubGlobal('window', {
      localStorage,
      sessionStorage,
      location: { href: '/sign-in?purchase=starter' },
      dispatchEvent,
    });
    authenticationSession.logOut({ preserveCheckoutIntent: true });
    expect(checkoutIntent.clear).not.toHaveBeenCalled();
    expect(window.location.href).toBe('/sign-in');
    authenticationSession.saveResponse(
      {
        token: 'new-session',
        projectId: 'new-workspace',
      } as AuthenticationResponse,
      false,
    );
    expect(checkoutIntent.billingPath()).toBe('/platform/billing');
    authenticationSession.logOut();
    expect(checkoutIntent.billingPath()).toBeNull();
  });
  it('preserves the selection across a verified session replacement and workspace response', () => {
    const response = {
      token: 'fixture-token',
      projectId: 'workspace-project',
    } as AuthenticationResponse;
    authenticationSession.clearSession({ preserveCheckoutIntent: true });
    authenticationSession.saveResponse(response, false);
    expect(checkoutIntent.clear).not.toHaveBeenCalled();
    expect(checkoutIntent.billingPath()).toBe('/platform/billing');
  });

  it('clears the selection on an explicit session reset', () => {
    authenticationSession.clearSession();
    expect(checkoutIntent.clear).toHaveBeenCalledOnce();
    expect(checkoutIntent.billingPath()).toBeNull();
  });
});
