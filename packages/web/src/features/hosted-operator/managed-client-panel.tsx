import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { assertAuthSession } from '@/features/hosted-onboarding/auth-session';

import {
  ClientAdminError,
  ManagedClient,
  clientPlanName,
  managedClientQuery,
  requestClient,
} from './client-admin-api';
import { ClientCreditAllowanceSection } from './credit-allowance-section';
import { useHostedOperatorAccess } from './operator-api';
import { PartnerCandidate, assignPartner, lookupPartner } from './partners-api';

type Access = ReturnType<typeof useHostedOperatorAccess>;
export function ManagedClientPanel({
  access,
  platformId,
  onClose,
}: {
  access: Access;
  platformId: string;
  onClose: () => void;
}) {
  const query = useQuery(
    managedClientQuery(access.session, platformId, access.allowed),
  );
  return (
    <section
      aria-label="Manage client"
      className="space-y-5 border-y border-gray-6 py-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Manage client</h2>
        <Button variant="ghost" onClick={onClose}>
          Close client details
        </Button>
      </div>
      {query.isPending ? (
        <p role="status">Loading client details…</p>
      ) : query.error ? (
        <div role="alert">
          <p>Client details could not load. Check your access and refresh.</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry client details
          </Button>
        </div>
      ) : query.data ? (
        <ClientDetails
          key={query.data.stateHash}
          access={access}
          client={query.data}
          refresh={() => void query.refetch()}
        />
      ) : null}
    </section>
  );
}
function ClientDetails({
  access,
  client,
  refresh,
}: {
  access: Access;
  client: ManagedClient;
  refresh: () => void;
}) {
  const cache = useQueryClient();
  const [name, setName] = useState(client.name),
    [reason, setReason] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function rename(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !name.trim() || reason.trim().length < 3) return;
    lock.current = true;
    setBusy(true);
    setNotice('');
    try {
      await requestClient(access.session, client.platformId, {
        profile: {
          name: name.trim(),
          expectedState: client.stateHash,
          reason: reason.trim(),
          confirmed: true,
        },
      });
      assertAuthSession(access.session);
      if (!mounted.current) return;
      setNotice('Client name saved.');
      void cache.invalidateQueries({ queryKey: ['hosted-operator-clients'] });
      refresh();
    } catch (error) {
      if (mounted.current)
        setNotice(
          error instanceof ClientAdminError && error.kind === 'conflict'
            ? 'This client changed. Refresh its details before saving again.'
            : 'The client name could not be saved. Refresh and try again.',
        );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <header>
        <h3 className="break-words text-xl font-semibold">{client.name}</h3>
        <p className="mt-1 text-sm text-gray-11">
          {clientPlanName(client.planId)} · {client.status} ·{' '}
          {client.funding === 'manual'
            ? 'Manual payment'
            : client.funding === 'stripe'
            ? 'Stripe subscription'
            : 'Funding needs review'}
        </p>
        <p className="mt-1 break-words text-sm text-gray-11">
          Owner: {client.owner.name} · {client.owner.email}
        </p>
      </header>
      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <Link
            to={`/learn?client=${client.platformId}&learner=${client.owner.identityId}`}
          >
            Manage learning for this client
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link
            to={`/platform/billing/subscriptions?client=${client.platformId}`}
          >
            Manage renewal and funding
          </Link>
        </Button>
      </div>
      <p className="text-sm text-gray-11">
        {client.limits.users} users · {client.limits.concurrency} simultaneous
        runs. Plan changes for Stripe subscriptions are managed by the client in
        Billing.
      </p>
      <form onSubmit={rename} className="max-w-xl space-y-3">
        <label
          className="block text-sm font-medium"
          htmlFor="managed-client-name"
        >
          Client name
        </label>
        <Input
          id="managed-client-name"
          value={name}
          maxLength={120}
          required
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <label
          className="block text-sm font-medium"
          htmlFor="managed-client-reason"
        >
          Reason for name change
        </label>
        <Input
          id="managed-client-reason"
          value={reason}
          minLength={3}
          maxLength={500}
          required
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
        />
        <Button
          type="submit"
          disabled={
            busy ||
            name.trim() === client.name ||
            !name.trim() ||
            reason.trim().length < 3
          }
        >
          {busy ? 'Saving…' : 'Save client name'}
        </Button>
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
      </form>
      <ClientPartnerAssignment
        access={access}
        client={client}
        refresh={refresh}
      />
      <ClientCreditAllowanceSection
        access={access}
        platformId={client.platformId}
        clientName={client.name}
      />
    </div>
  );
}
function ClientPartnerAssignment({
  access,
  client,
  refresh,
}: {
  access: Access;
  client: ManagedClient;
  refresh: () => void;
}) {
  const [email, setEmail] = useState(''),
    [candidate, setCandidate] = useState<PartnerCandidate | null>(null),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function lookup(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice('');
    setCandidate(null);
    try {
      const result = await lookupPartner(access.session, email.trim());
      assertAuthSession(access.session);
      if (mounted.current) {
        setCandidate(result.candidate);
        if (!result.candidate) setNotice('No Partner found for this email.');
      }
    } catch {
      if (mounted.current)
        setNotice('Partner lookup failed. Check your access and try again.');
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const assigned =
    candidate?.assignments.some(
      (value) => value.platformId === client.platformId && value.active,
    ) ?? false;
  async function assign() {
    if (
      !candidate ||
      candidate.role !== 'partner' ||
      !candidate.active ||
      lock.current
    )
      return;
    lock.current = true;
    setBusy(true);
    setNotice('');
    try {
      const result = await assignPartner(
        access.session,
        candidate,
        client.platformId,
        !assigned,
      );
      assertAuthSession(access.session);
      if (mounted.current) {
        setCandidate(result.candidate);
        setNotice(
          assigned
            ? 'Partner removed from this client.'
            : 'Partner assigned to this client.',
        );
        refresh();
      }
    } catch {
      if (mounted.current) {
        setCandidate(null);
        setNotice(
          'Assignment could not be saved. Look up the Partner again to load the current access state.',
        );
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      aria-labelledby="client-partners-heading"
      className="space-y-3 border-t border-gray-6 pt-5"
    >
      <h3 id="client-partners-heading" className="font-semibold">
        Assigned Partners
      </h3>
      {client.partners.length ? (
        <ul className="space-y-1 text-sm">
          {client.partners.map((partner) => (
            <li key={partner.identityId} className="break-words">
              {partner.name} · {partner.email}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-11">No Partners assigned.</p>
      )}
      <form onSubmit={lookup} className="max-w-xl space-y-3">
        <label
          htmlFor="client-partner-email"
          className="block text-sm font-medium"
        >
          Partner email
        </label>
        <Input
          id="client-partner-email"
          type="email"
          required
          value={email}
          disabled={busy}
          onChange={(event) => {
            setEmail(event.target.value);
            setCandidate(null);
          }}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={busy || !email.trim()}
        >
          Find Partner
        </Button>
      </form>
      {candidate && (
        <div className="space-y-2 text-sm">
          <p className="break-words">
            {candidate.firstName} {candidate.lastName} · {candidate.email}
          </p>
          {candidate.role === 'partner' &&
          candidate.active &&
          candidate.editable ? (
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => void assign()}
            >
              {assigned
                ? 'Remove Partner from client'
                : 'Assign Partner to client'}
            </Button>
          ) : (
            <p>This identity is not an editable active Partner.</p>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
