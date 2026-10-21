import { describe, expect, it, vi } from 'vitest';

import {
  CHECKOUT_INTENT_KEY,
  CHECKOUT_INTENT_TTL_MS,
  createCheckoutIntentStore,
  isLocalCheckoutOrigin,
  parseCheckoutOffer,
} from '@/lib/checkout-intent';

function fixture(origin = 'http://127.0.0.1:3289') {
  const values = new Map<string, string>();
  let time = 100_000;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  return {
    values,
    store: createCheckoutIntentStore({ storage, origin, now: () => time }),
    advance: (milliseconds: number) => (time += milliseconds),
  };
}

describe('local checkout selection', () => {
  it.each(['starter', 'growth', 'partner-core', 'partner-guided'])(
    'retains the public %s offer through sign-in and workspace navigation',
    (offer) => {
      const { store, values } = fixture();
      store.capture(
        `?sandbox=1&purchase=${offer}&token=ignored&returnUrl=https://example.com`,
      );
      expect(store.capture('')).toEqual({ offer, createdAt: 100_000 });
      expect(store.capture('?from=%2Fplatform%2Fprojects')).toEqual(
        store.read(),
      );
      expect(store.billingPath()).toBe('/platform/billing');
      expect(JSON.parse(values.get(CHECKOUT_INTENT_KEY)!)).toEqual({
        offer,
        createdAt: 100_000,
      });
    },
  );

  it.each([
    '?purchase=starter',
    '?sandbox=0&purchase=starter',
    '?sandbox=1&purchase=scale',
    '?sandbox=1&purchase=enterprise',
    '?sandbox=1&purchase=team',
    '?sandbox=1&purchase=https://example.com',
    '?sandbox=1&purchase=starter&purchase=growth',
    '?sandbox=1&sandbox=1&purchase=starter',
  ])('rejects ambiguous or unsupported selection %s', (search) => {
    const { store } = fixture();
    store.capture('?sandbox=1&purchase=starter');
    expect(store.capture(search)).toBeNull();
    expect(store.billingPath()).toBeNull();
  });

  it.each([
    'https://www.sydekyks.com',
    'http://127.0.0.1:4173',
    'https://127.0.0.1:3289',
    'http://localhost.example.com:3289',
    'http://127.0.0.1:3289/other',
    'http://user@127.0.0.1:3289',
  ])('refuses a non-approved application origin %s', (origin) => {
    expect(isLocalCheckoutOrigin(origin)).toBe(false);
    expect(
      parseCheckoutOffer('?sandbox=1&purchase=starter', origin),
    ).toBeNull();
    expect(
      fixture(origin).store.capture('?sandbox=1&purchase=starter'),
    ).toBeNull();
  });

  it('accepts only the two known ports on literal loopback hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      for (const port of ['3281', '3289']) {
        expect(isLocalCheckoutOrigin(`http://${host}:${port}`)).toBe(true);
      }
    }
  });

  it('expires the selection and clears it when the person resets the flow', () => {
    const { store, advance } = fixture();
    store.capture('?sandbox=1&purchase=growth');
    advance(CHECKOUT_INTENT_TTL_MS);
    expect(store.read()).toBeNull();
    store.capture('?sandbox=1&purchase=partner-guided');
    store.clear();
    expect(store.billingPath()).toBeNull();
  });

  it('rejects altered stored fields, future timestamps and unavailable storage', () => {
    const { store, values } = fixture();
    for (const value of [
      { offer: 'starter', createdAt: 100_001 },
      { offer: 'starter', createdAt: 100_000, platformId: 'other' },
      { offer: 'starter', createdAt: '100000' },
      { offer: 'scale', createdAt: 100_000 },
    ]) {
      values.set(CHECKOUT_INTENT_KEY, JSON.stringify(value));
      expect(store.read()).toBeNull();
    }
    const blocked = createCheckoutIntentStore({
      storage: null,
      origin: 'http://127.0.0.1:3289',
    });
    expect(blocked.capture('?sandbox=1&purchase=starter')).toBeNull();
  });

  it('never sends a request while capturing or resuming a selection', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const { store } = fixture();
      store.capture('?sandbox=1&purchase=starter');
      store.capture('?from=%2Fplatform%2Fbilling');
      store.billingPath();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
