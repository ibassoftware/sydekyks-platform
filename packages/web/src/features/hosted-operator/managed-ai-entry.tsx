import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';

import { AiSettings, useAiSettings } from './ai-settings-api';
import { useHostedOperatorAccess } from './operator-api';

export function managedAiNextStep(state: AiSettings, globallyPaused = false) {
  if (globallyPaused && state.scopePlatformId !== null)
    return 'Enable the global default to resume managed AI for this client.';
  if (state.mode === 'disabled')
    return state.scopePlatformId === null
      ? 'Enable the global default to resume managed AI.'
      : 'Choose inheritance or a client override to enable managed AI.';
  if (!state.credential.configured)
    return 'Save a provider key to continue setup.';
  if (!state.effective.model)
    return 'Select and save a model to continue setup.';
  if (state.effective.managedAvailable)
    return 'Ready for eligible workspaces within their Credit limits.';
  if (state.pricing.status === 'checking')
    return 'Official pricing is being checked. Refresh pricing status when the check finishes.';
  if (!state.pricing.terms || !state.pricing.observationId)
    return 'Observe official pricing, then review and approve it to finish setup.';
  if (
    !state.pricing.approval ||
    ['needs_approval', 'mismatch'].includes(state.pricing.status)
  )
    return 'Key and model saved. Review and approve published pricing to finish setup.';
  return 'Refresh official pricing and review its approval to restore managed AI.';
}

export function HostedManagedAiEntry({
  access,
}: {
  access: ReturnType<typeof useHostedOperatorAccess>;
}) {
  const settings = useAiSettings(access.session, access.allowed);
  if (!access.allowed) return null;
  return (
    <section
      aria-labelledby="managed-ai-entry-heading"
      className="mb-8 border-b border-gray-6 pb-8"
    >
      <h1 id="managed-ai-entry-heading" className="text-xl font-semibold">
        Sydekyks managed AI default
      </h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-11">
        The shared Sydekyks service for clients that inherit the global default.
      </p>
      {settings.isPending ? (
        <p role="status" className="mt-4 text-sm">
          Checking the saved managed default…
        </p>
      ) : settings.isError ? (
        <div role="alert" className="mt-4 text-sm">
          <p>
            The saved default could not load. Refresh its status or open Managed
            AI settings.
          </p>
          <Button
            className="mt-3"
            variant="outline"
            onClick={() => void settings.refetch()}
          >
            Refresh default status
          </Button>
        </div>
      ) : (
        <>
          <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="font-medium">Global default</dt>
            <dd>
              {settings.data.mode === 'set'
                ? 'Enabled for inheriting clients'
                : settings.data.mode === 'disabled'
                ? 'Paused for all clients'
                : 'Setup required'}
            </dd>
            <dt className="font-medium">Provider key</dt>
            <dd>
              {settings.data.credential.configured
                ? 'Saved securely · value hidden'
                : 'Not configured'}
            </dd>
            <dt className="font-medium">Saved model</dt>
            <dd>
              {settings.data.effective.model === 'deepseek-flash'
                ? 'DeepSeek Flash'
                : settings.data.effective.model === 'deepseek-v4-pro'
                ? 'DeepSeek V4 Pro'
                : 'Not selected'}
            </dd>
            <dt className="font-medium">Service readiness</dt>
            <dd>
              {settings.data.effective.managedAvailable
                ? 'Ready'
                : 'Setup required'}
            </dd>
          </dl>
          <p className="mt-4 max-w-3xl text-sm leading-6">
            {managedAiNextStep(settings.data)}
          </p>
        </>
      )}
      <Button asChild className="mt-4">
        <Link to="/platform/managed-ai">Manage Sydekyks default</Link>
      </Button>
    </section>
  );
}
