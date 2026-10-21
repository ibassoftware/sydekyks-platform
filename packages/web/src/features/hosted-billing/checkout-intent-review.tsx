import { t } from 'i18next';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

import { CHECKOUT_INTENT_EVENT, checkoutIntent } from './checkout-intent';

export function useCheckoutIntent() {
  const [intent, setIntent] = useState(checkoutIntent.read);
  useEffect(() => {
    const update = () => setIntent(checkoutIntent.read());
    window.addEventListener(CHECKOUT_INTENT_EVENT, update);
    window.addEventListener('focus', update);
    window.addEventListener('pageshow', update);
    const timer = setInterval(update, 60_000);
    update();
    return () => {
      clearInterval(timer);
      window.removeEventListener(CHECKOUT_INTENT_EVENT, update);
      window.removeEventListener('focus', update);
      window.removeEventListener('pageshow', update);
    };
  }, []);
  return { intent, clearIntent: checkoutIntent.clear };
}

export function CheckoutIntentReview() {
  const { intent, clearIntent } = useCheckoutIntent();
  if (!intent) return null;
  const selected = {
    starter: { name: t('Starter'), price: t('$99 USD / month') },
    growth: { name: t('Growth'), price: t('$399 USD / month') },
    'partner-core': {
      name: t('Partner Core'),
      price: t('$1,000 USD one time'),
    },
    'partner-guided': {
      name: t('Partner Guided'),
      price: t('$1,200 USD one time'),
    },
  }[intent.offer];
  return (
    <section
      className="mb-6 space-y-3 border-b border-gray-6 pb-6"
      aria-labelledby="checkout-selection-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="checkout-selection-heading" className="text-lg font-semibold">
            {t('Selected for review: {name}', { name: selected.name })}
          </h2>
          <p className="text-sm font-medium tabular-nums">{selected.price}</p>
        </div>
        <Button variant="outline" size="sm" onClick={clearIntent}>
          {t('Clear selection')}
        </Button>
      </div>
      <p className="max-w-prose text-sm leading-6 text-gray-11">
        {t(
          'This is a local Stripe sandbox selection. Review the account, workspace and offer below. Payment starts only when you explicitly confirm checkout.',
        )}
      </p>
    </section>
  );
}
