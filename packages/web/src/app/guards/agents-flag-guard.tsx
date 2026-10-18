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
  if (hosted) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">
          Agents are unavailable in this pilot
        </h1>
        <p className="my-4 text-sm leading-6 text-gray-11">
          Use manually started workflows with Code and Ask AI, or use Sydekyks
          chat for conversation. Review drafts yourself before sharing.
        </p>
        <Button asChild variant="outline">
          <Link to="/chat">Open Sydekyks chat</Link>
        </Button>
      </main>
    );
  }
  if (!agentsAvailable) {
    return <Navigate to="/flows" replace />;
  }
  return children;
};
