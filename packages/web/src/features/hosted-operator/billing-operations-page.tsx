import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { ChargeResolutionSection } from './charge-resolution-section';
import { operatorClientsQuery, useHostedOperatorAccess } from './operator-api';
import { StripeCatalogSection } from './stripe-catalog-section';

export function BillingOperationsPage() {
  const access = useHostedOperatorAccess();
  return <SessionOperations key={access.session.epoch} access={access} />;
}

function SessionOperations({
  access,
}: {
  access: ReturnType<typeof useHostedOperatorAccess>;
}) {
  const [scope, setScope] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const clients = useQuery(
    operatorClientsQuery(
      access.session,
      cursors[cursors.length - 1],
      access.allowed,
    ),
  );
  const client = clients.data?.clients.find(
    (value) => value.platformId === scope,
  );
  function page(next: boolean) {
    setScope('');
    setCursors((values) =>
      next ? [...values, clients.data?.next ?? null] : values.slice(0, -1),
    );
  }
  return (
    <main className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-8 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold">Billing operations</h1>
        <p className="mt-2 max-w-prose text-sm leading-6 text-gray-11">
          Review a workspace’s Stripe catalog binding and held AI charges. Every
          confirmed change records your evidence and reason.
        </p>
      </header>
      {!access.hosted || access.session.kind !== 'user' ? (
        <p role="status">
          Sign in to your hosted Sydekyks operator account to manage billing
          operations.
        </p>
      ) : access.isPending ? (
        <p role="status">Checking operator access…</p>
      ) : !access.allowed ? (
        <p role="alert">
          Only configured Sydekyks operators can manage billing operations.
          Partners, Trainers and client administrators do not have access.
        </p>
      ) : (
        <>
          <section aria-labelledby="billing-workspace-heading">
            <h2
              id="billing-workspace-heading"
              className="text-lg font-semibold"
            >
              Choose a workspace
            </h2>
            <label
              htmlFor="billing-workspace"
              className="mt-4 block text-sm font-medium"
            >
              Partner or client workspace
            </label>
            <select
              id="billing-workspace"
              value={scope}
              disabled={clients.isFetching}
              onChange={(event) => setScope(event.target.value)}
              className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-9"
            >
              <option value="">Select a workspace</option>
              {clients.data?.clients.map((value) => (
                <option key={value.platformId} value={value.platformId}>
                  {value.name}
                </option>
              ))}
            </select>
            {clients.isPending ? (
              <p role="status" className="mt-3 text-sm">
                Loading workspaces…
              </p>
            ) : clients.isError ? (
              <p role="alert" className="mt-3 text-sm">
                Workspaces could not load. Refresh the list to try again.
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-3">
              <Button
                variant="outline"
                disabled={clients.isFetching}
                onClick={() => {
                  setScope('');
                  void clients.refetch();
                }}
              >
                Refresh workspaces
              </Button>
              <Button
                variant="outline"
                disabled={cursors.length === 1 || clients.isFetching}
                onClick={() => page(false)}
              >
                Previous workspaces
              </Button>
              <Button
                variant="outline"
                disabled={!clients.data?.next || clients.isFetching}
                onClick={() => page(true)}
              >
                More workspaces
              </Button>
            </div>
          </section>
          {client ? (
            <div
              key={`${access.session.epoch}:${client.platformId}`}
              className="flex min-w-0 flex-col gap-8"
            >
              <ChargeResolutionSection
                access={access}
                scopePlatformId={client.platformId}
                clientName={client.name}
              />
              <StripeCatalogSection
                access={access}
                scopePlatformId={client.platformId}
                clientName={client.name}
              />
            </div>
          ) : (
            <p role="status" className="text-sm text-gray-11">
              Choose a workspace to inspect its billing state.
            </p>
          )}
        </>
      )}
    </main>
  );
}
