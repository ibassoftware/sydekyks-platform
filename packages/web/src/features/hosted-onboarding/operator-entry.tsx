import { t } from 'i18next';
import { Link } from 'react-router-dom';

import { FullLogo } from '@/components/custom/full-logo';
import { Button } from '@/components/ui/button';

export function HostedOperatorEntry({
  checking,
  failed,
  onRefresh,
  onExit,
}: {
  checking: boolean;
  failed: boolean;
  onRefresh: () => void;
  onExit: () => void;
}) {
  return (
    <main className="min-h-dvh bg-gray-2 px-4 py-6 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8">
          <FullLogo />
        </header>
        <section
          className="rounded-2xl border bg-gray-1 p-5 sm:p-8"
          aria-labelledby="operator-entry-title"
        >
          <h1 id="operator-entry-title" className="text-xl font-semibold">
            {checking
              ? t('Checking your access…')
              : failed
              ? t('Access could not be verified')
              : t('Platform administration')}
          </h1>
          {checking ? (
            <p role="status" className="mt-3 text-sm text-gray-11">
              {t('Checking your Sydekyks account.')}
            </p>
          ) : failed ? (
            <>
              <p role="alert" className="mt-3 text-sm text-gray-11">
                {t('Refresh to verify your account before continuing.')}
              </p>
              <Button className="mt-5" onClick={onRefresh}>
                {t('Check access again')}
              </Button>
            </>
          ) : (
            <>
              <p className="mt-3 text-sm leading-6 text-gray-11">
                {t(
                  'Manage Partners, client workspaces and training as a Sydekyks administrator.',
                )}
              </p>
              <nav
                aria-label={t('Platform administration')}
                className="mt-6 flex flex-wrap gap-3"
              >
                <Button asChild>
                  <Link to="/platform/partners">{t('Manage Partners')}</Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link to="/learn">{t('Manage training')}</Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link to="/platform/managed-ai">
                    {t('Managed AI settings')}
                  </Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link to="/platform/billing">
                    {t('Billing administration')}
                  </Link>
                </Button>
              </nav>
            </>
          )}
          <Button variant="link" className="mt-6 px-0" onClick={onExit}>
            {t('Use another account')}
          </Button>
        </section>
      </div>
    </main>
  );
}
