import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { formatHostedCredits } from '@/features/hosted-chat/hosted-chat-api';

import { clientPlanName } from './client-admin-api';
import { ManagedClientPanel } from './managed-client-panel';
import { ManualAccountForm } from './manual-account-form';
import {
  HostedClients,
  operatorClientsQuery,
  useHostedOperatorAccess,
} from './operator-api';

export function HostedClientsPage() {
  const access = useHostedOperatorAccess();
  if (!access.hosted || access.session.kind !== 'user')
    return (
      <main className="p-4 sm:p-6">
        <p role="status" className="text-sm text-gray-11">
          {t(
            access.hosted
              ? 'Sign in again to view client usage.'
              : 'Client usage is available only for hosted service operators.',
          )}
        </p>
      </main>
    );
  return <SessionClients key={access.session.epoch} access={access} />;
}
function SessionClients({
  access,
}: {
  access: ReturnType<typeof useHostedOperatorAccess>;
}) {
  const [params, setParams] = useSearchParams();
  const kind =
    params.get('kind') === 'partner'
      ? 'partner'
      : params.get('kind') === 'trial'
      ? 'trial'
      : 'client';
  const target = params.get('client') ?? '';
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const after = cursors[cursors.length - 1];
  const query = useQuery(
    operatorClientsQuery(access.session, after, access.allowed, kind),
  );
  const denied = !access.isPending && !access.allowed;
  return (
    <main className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('Clients')}</h1>
          <p className="mt-1 max-w-prose text-sm text-gray-11">
            {t(
              'Manage client accounts, assigned Partners, learning and Credits.',
            )}
          </p>
        </div>
        {access.allowed && (
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {t('Refresh usage')}
          </Button>
        )}
      </div>
      {access.allowed && (
        <nav aria-label="Account type" className="flex flex-wrap gap-2">
          {(['client', 'partner', 'trial'] as const).map((value) => (
            <Button
              key={value}
              variant={kind === value ? 'default' : 'outline'}
              aria-pressed={kind === value}
              onClick={() => {
                setCursors([null]);
                setParams({ kind: value });
              }}
            >
              {value === 'client'
                ? 'Clients'
                : value === 'partner'
                ? 'Partner hosting'
                : 'Trials'}
            </Button>
          ))}
        </nav>
      )}
      {access.allowed && kind === 'client' && (
        <ManualAccountForm
          session={access.session}
          kind="client"
          onCreated={() => void query.refetch()}
        />
      )}
      {access.allowed && target && kind === 'client' && (
        <ManagedClientPanel
          key={`${access.session.epoch}:${target}`}
          access={access}
          platformId={target}
          onClose={() => setParams({ kind })}
        />
      )}
      {access.isPending ? (
        <p role="status" className="text-sm text-gray-11">
          {t('Checking operator access…')}
        </p>
      ) : denied ? (
        <p role="alert" className="text-sm text-gray-11">
          {t(
            'This view is available only to configured service operators. A client workspace administrator cannot access other clients.',
          )}
        </p>
      ) : query.isPending ? (
        <p role="status" className="text-sm text-gray-11">
          {t('Loading client usage…')}
        </p>
      ) : query.error ? (
        <p role="alert" className="text-sm text-gray-11">
          {t(
            'Client usage could not be loaded. Refresh to check your access and connection.',
          )}
        </p>
      ) : query.data ? (
        <ClientUsageTable
          data={query.data}
          onManage={
            kind === 'client'
              ? (platformId) => setParams({ kind, client: platformId })
              : undefined
          }
        />
      ) : null}
      {access.allowed && !query.error && query.data && (
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="outline"
            disabled={cursors.length === 1 || query.isFetching}
            onClick={() => setCursors((value) => value.slice(0, -1))}
          >
            {t('Previous clients')}
          </Button>
          <Button
            variant="outline"
            disabled={!query.data.next || query.isFetching}
            onClick={() => setCursors((value) => [...value, query.data!.next])}
          >
            {t('More clients')}
          </Button>
        </div>
      )}
    </main>
  );
}
function ClientUsageTable({
  data,
  onManage,
}: {
  data: HostedClients;
  onManage?: (platformId: string) => void;
}) {
  const number = (value: string) => formatHostedCredits(value);
  if (!data.clients.length)
    return (
      <p role="status" className="text-sm text-gray-11">
        {t('No hosted clients have been provisioned yet.')}
      </p>
    );
  return (
    <>
      <div
        className="min-w-0 overflow-x-auto rounded-lg border"
        tabIndex={0}
        role="region"
        aria-label={t('Client credit usage table')}
      >
        <table className="w-full min-w-[54rem] text-left text-sm">
          <caption className="sr-only">
            {t('Current credit period and recorded model usage by client')}
          </caption>
          <thead className="border-b bg-gray-2">
            <tr>
              {[
                'Client',
                'Credits',
                'Active runs',
                'Recorded model attempts · all time',
              ].map((label) => (
                <th key={label} scope="col" className="px-4 py-3 font-medium">
                  {t(label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.clients.map((client) => (
              <tr key={client.platformId} className="border-b last:border-b-0">
                <th scope="row" className="max-w-64 px-4 py-4 font-medium">
                  <span className="block break-words">{client.name}</span>
                  <span className="mt-1 block text-xs font-normal text-gray-11">
                    {clientPlanName(client.planId)} · {client.status}
                  </span>
                  <span className="mt-1 block text-xs font-normal text-gray-11">
                    {t('Access through {date}', {
                      date: new Date(client.validUntil).toLocaleDateString(),
                    })}
                  </span>
                  {onManage && (
                    <Button
                      className="mt-3"
                      variant="outline"
                      size="sm"
                      onClick={() => onManage(client.platformId)}
                      aria-label={`Manage client ${client.name}`}
                    >
                      Manage client
                    </Button>
                  )}
                </th>
                {[client.credits.execution].map((meter, index) => (
                  <td key={index} className="px-4 py-4 tabular-nums">
                    <span className="block">
                      {t('{used} used / {total}', {
                        used: formatHostedCredits(meter.consumed, meter.scale),
                        total: formatHostedCredits(meter.amount, meter.scale),
                      })}
                    </span>
                    <span className="mt-1 block text-xs text-gray-11">
                      {t('{available} available · {held} held', {
                        available: formatHostedCredits(
                          meter.available,
                          meter.scale,
                        ),
                        held: formatHostedCredits(meter.reserved, meter.scale),
                      })}
                    </span>
                  </td>
                ))}
                <td className="px-4 py-4 tabular-nums">
                  {client.activeExecutions}
                </td>
                <td className="px-4 py-4 tabular-nums">
                  <span className="block">
                    {t('{value} recorded attempts', {
                      value: number(client.modelCalls.calls),
                    })}
                  </span>
                  <span className="mt-1 block text-xs text-gray-11">
                    {t('{value} verified tokens', {
                      value: number(client.modelCalls.verifiedTokens),
                    })}
                  </span>
                  {BigInt(client.modelCalls.uncertain) > 0n && (
                    <span className="mt-1 block text-xs text-danger-11">
                      {t('{value} uncertain calls', {
                        value: number(client.modelCalls.uncertain),
                      })}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="max-w-prose text-xs text-gray-11">
        {t(
          'Credit totals refer to each client’s current or most recent credit period. Model-call counts and verified token totals cover all recorded history. Uncertain calls keep their holds until resolved. Provider secrets and conversation contents are never included.',
        )}
      </p>
    </>
  );
}
