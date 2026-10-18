import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';

import { AiSettings, useAiSettings } from './ai-settings-api';
import { useHostedOperatorAccess } from './operator-api';

export function managedAiNextStep(state: AiSettings) {
  if (state.mode === 'disabled')
    return 'Enable the global default in Managed AI settings when you are ready to resume managed usage.';
  if (!state.credential.configured)
    return 'Save a provider key in Managed AI settings for the shared Sydekyks default.';
  if (!state.effective.model)
    return 'Select and save an upstream model in Managed AI settings.';
  if (state.effective.managedAvailable)
    return 'The saved default is available to eligible workspaces within their credit limits.';
  if (!state.pricing.approval)
    return 'The key and model are saved. Review and approve published pricing in Managed AI settings to finish setup.';
  return 'Refresh the official pricing source and review the current approval in Managed AI settings.';
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
        Set the shared service here through Managed AI settings. Customers see
        Sydekyks and credits; client workspaces inherit the saved global default
        unless they have an explicit override.
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
                ? 'Sydekyks selected — clients inherit unless overridden'
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
            <dt className="font-medium">Managed service</dt>
            <dd>
              {settings.data.effective.managedAvailable
                ? 'Available with current approved pricing'
                : 'Unavailable — action needed below'}
            </dd>
          </dl>
          <p className="mt-4 max-w-3xl text-sm leading-6">
            {managedAiNextStep(settings.data)}
          </p>
          {settings.data.effective.reason && (
            <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-11">
              {settings.data.effective.reason}
            </p>
          )}
        </>
      )}
      <Button asChild className="mt-4">
        <Link to="/platform/managed-ai">Manage Sydekyks default</Link>
      </Button>
    </section>
  );
}
