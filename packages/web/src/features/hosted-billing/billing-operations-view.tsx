import { t } from 'i18next';
import { ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';

import { CenteredPage } from '@/components/custom/centered-page';

// This view is mounted only after the operator access endpoint allows the session.
export function HostedBillingOperationsView() {
  const destinations = [
    {
      title: t('Client billing'),
      description: t('Review workspace access, Credits and usage.'),
      to: '/platform/billing/clients',
    },
    {
      title: t('Subscriptions & renewals'),
      description: t('Review paid terms and arrange workspace renewals.'),
      to: '/platform/billing/subscriptions',
    },
    {
      title: t('Billing operations'),
      description: t('Review checkout configuration and payment exceptions.'),
      to: '/platform/billing-operations',
    },
    {
      title: t('Managed AI controls'),
      description: t(
        'Manage the shared Sydekyks AI service and pricing approval.',
      ),
      to: '/platform/managed-ai',
    },
  ];
  return (
    <CenteredPage
      title={t('Billing')}
      description={t(
        'Manage billing and service access across Sydekyks workspaces.',
      )}
      widthClassName="max-w-[56rem]"
    >
      <nav aria-label={t('Billing administration')} className="divide-y">
        {destinations.map((destination) => (
          <Link
            key={destination.to}
            to={destination.to}
            className="group flex items-center justify-between gap-4 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-9 focus-visible:outline-offset-4"
          >
            <div>
              <h2 className="text-base font-semibold group-hover:underline underline-offset-4">
                {destination.title}
              </h2>
              <p className="mt-1 text-sm text-gray-11">
                {destination.description}
              </p>
            </div>
            <ArrowUpRight
              className="size-4 shrink-0 text-gray-11"
              aria-hidden="true"
            />
          </Link>
        ))}
      </nav>
    </CenteredPage>
  );
}
