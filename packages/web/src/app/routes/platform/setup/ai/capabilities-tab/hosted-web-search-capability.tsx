import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { Search } from 'lucide-react';
import { Link } from 'react-router-dom';

import { adminSurface, StatusDot } from '@/app/components/admin';
import { Button } from '@/components/ui/button';
import { hostedChatApi } from '@/features/hosted-chat/hosted-chat-api';
import { useHostedAuthSession } from '@/features/hosted-onboarding/auth-session';
import { authenticationSession } from '@/lib/authentication-session';
import { cn } from '@/lib/utils';

export function HostedWebSearchCapability() {
  const session = useHostedAuthSession();
  const projectPointer = authenticationSession.getProjectId() ?? '';
  const hasScope = session.kind === 'user' && projectPointer.length === 21;
  const availability = useQuery({
    queryKey: [
      'hosted-web-search-capability',
      session.epoch,
      session.platformId,
      session.id,
      projectPointer,
    ],
    queryFn: ({ signal }) =>
      hostedChatApi.options(
        { session, projectPointer, conversationId: null },
        signal,
      ),
    enabled: hasScope,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  const available =
    hasScope &&
    !availability.isPending &&
    !availability.isError &&
    availability.data?.nativeFeatures?.webSearch === true;
  const status = !hasScope
    ? t('Select a Command Center to check availability')
    : availability.isPending
    ? t('Checking availability…')
    : availability.isError
    ? t('Status unavailable')
    : available
    ? t('Available in this Command Center')
    : t('Currently unavailable in this Command Center');

  return (
    <section
      aria-labelledby="hosted-web-search-heading"
      className={cn(adminSurface.card, 'flex flex-col')}
    >
      <div className="flex items-start gap-4 px-5 pt-5 pb-2">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-gray-1">
          <Search className="size-4 text-gray-11" aria-hidden="true" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2
            id="hosted-web-search-heading"
            className="text-sm font-semibold text-gray-12"
          >
            {t('Web Search')}
          </h2>
          <div role="status">
            <StatusDot
              tone={available ? 'success' : 'neutral'}
              className="text-xs text-gray-11"
            >
              {status}
            </StatusDot>
          </div>
        </div>
      </div>
      <div className="space-y-3 px-5 pb-5 text-sm leading-6 text-gray-11">
        <p>
          {t(
            'Search the web from Sydekyks and supported AI Mission steps. No separate search service key is needed.',
          )}
        </p>
        <p>
          {t(
            'Turn on Web in a Sydekyk conversation, or enable web search in the AI step. Usage follows the selected AI provider and your workspace Credit limits.',
          )}
        </p>
        {hasScope &&
          !availability.isPending &&
          !availability.isError &&
          !available && (
            <p>
              {t(
                'Check workspace access, available Credits and AI provider readiness, or contact your administrator.',
              )}
            </p>
          )}
        {availability.isError && hasScope && (
          <div role="alert">
            <p>
              {t(
                'Availability could not be checked. Try again to refresh its status.',
              )}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void availability.refetch()}
            >
              {t('Retry availability check')}
            </Button>
          </div>
        )}
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
        <span className="text-xs text-gray-11">{t('Built into Sydekyks')}</span>
        <Button asChild variant="outline" size="sm">
          <Link to="/agents">{t('Open Sydekyks')}</Link>
        </Button>
      </div>
    </section>
  );
}
