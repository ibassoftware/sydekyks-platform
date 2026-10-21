import { t } from 'i18next';
import { Link, Navigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { useAgentsAvailable } from '@/features/agents';
import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';

type AgentsFlagGuardProps = {
  children: React.ReactNode;
};

export const AgentsFlagGuard = ({ children }: AgentsFlagGuardProps) => {
  const agentsAvailable = useAgentsAvailable();
  const hosted = useHostedBillingEnabled();
  if (hosted && !agentsAvailable) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">
          {t('Agents are not ready in this workspace')}
        </h1>
        <p className="my-4 text-sm leading-6 text-gray-11">
          {t(
            'Refresh the workspace to check availability. Contact Sydekyks support if Agents remain unavailable.',
          )}
        </p>
        <Button asChild variant="outline">
          <Link to="/chat">{t('Open Sydekyks chat')}</Link>
        </Button>
      </main>
    );
  }
  if (!agentsAvailable) {
    return <Navigate to="/flows" replace />;
  }
  return children;
};
