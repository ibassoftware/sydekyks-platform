export const CHECKOUT_INTENT_KEY = 'sydekyks.localCheckoutIntent.v1';
export const CHECKOUT_INTENT_TTL_MS = 60 * 60 * 1000;

const offers = ['starter', 'growth', 'partner-core', 'partner-guided'] as const;
export type CheckoutOffer = (typeof offers)[number];
export type CheckoutIntent = Readonly<{
  offer: CheckoutOffer;
  createdAt: number;
}>;
type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// These are local review origins, never a caller-supplied return URL.
export function isLocalCheckoutOrigin(origin: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].some((host) =>
    ['3281', '3289'].some((port) => origin === `http://${host}:${port}`),
  );
}

function isOffer(value: unknown): value is CheckoutOffer {
  return offers.some((offer) => offer === value);
}

export function parseCheckoutOffer(
  search: string,
  origin: string,
): CheckoutOffer | null {
  if (!isLocalCheckoutOrigin(origin)) return null;
  const params = new URLSearchParams(search);
  const purchase = params.getAll('purchase');
  const sandbox = params.getAll('sandbox');
  return purchase.length === 1 &&
    sandbox.length === 1 &&
    sandbox[0] === '1' &&
    isOffer(purchase[0])
    ? purchase[0]
    : null;
}

export function createCheckoutIntentStore({
  storage,
  origin,
  now = Date.now,
  onChange = () => {},
}: {
  storage: IntentStorage | null;
  origin: string;
  now?: () => number;
  onChange?: () => void;
}) {
  function clear() {
    try {
      storage?.removeItem(CHECKOUT_INTENT_KEY);
    } catch {
      /* Storage may be unavailable in a private browser. */
    }
    onChange();
  }
  function read(): CheckoutIntent | null {
    if (!storage || !isLocalCheckoutOrigin(origin)) return null;
    try {
      const raw = storage.getItem(CHECKOUT_INTENT_KEY);
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      if (
        typeof value !== 'object' ||
        value === null ||
        !('offer' in value) ||
        !isOffer(value.offer) ||
        !('createdAt' in value) ||
        typeof value.createdAt !== 'number' ||
        !Number.isSafeInteger(value.createdAt) ||
        value.createdAt > now() ||
        now() - value.createdAt >= CHECKOUT_INTENT_TTL_MS ||
        Object.keys(value).some((key) => !['offer', 'createdAt'].includes(key))
      ) {
        storage.removeItem(CHECKOUT_INTENT_KEY);
        return null;
      }
      return Object.freeze({ offer: value.offer, createdAt: value.createdAt });
    } catch {
      return null;
    }
  }
  function capture(search: string): CheckoutIntent | null {
    const params = new URLSearchParams(search);
    if (!params.has('purchase')) return read();
    const offer = parseCheckoutOffer(search, origin);
    if (!offer) {
      clear();
      return null;
    }
    const intent = Object.freeze({ offer, createdAt: now() });
    try {
      storage?.setItem(CHECKOUT_INTENT_KEY, JSON.stringify(intent));
    } catch {
      return null;
    }
    onChange();
    return storage ? intent : null;
  }
  return {
    capture,
    read,
    clear,
    billingPath: () => (read() ? '/platform/billing' : null),
  };
}

export const CHECKOUT_INTENT_EVENT = 'sydekyks-checkout-intent';
function browserStore() {
  let storage: IntentStorage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    /* A blocked storage API cannot retain a checkout selection. */
  }
  return createCheckoutIntentStore({
    storage,
    origin: window.location.origin,
    onChange: () => window.dispatchEvent(new Event(CHECKOUT_INTENT_EVENT)),
  });
}
export const checkoutIntent = {
  capture: (search: string) => browserStore().capture(search),
  read: () => browserStore().read(),
  clear: () => browserStore().clear(),
  billingPath: () => browserStore().billingPath(),
};
