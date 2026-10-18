import { useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { operatorClientsQuery, useHostedOperatorAccess } from './operator-api';
import {
  assignPartner,
  decidePartner,
  lookupPartner,
  PartnerAdminError,
  PartnerCandidate,
  partnersQuery,
} from './partners-api';

type Access = ReturnType<typeof useHostedOperatorAccess>;
const selectStyle =
  'mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-9';
function name(candidate: PartnerCandidate) {
  return (
    [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') ||
    candidate.email
  );
}
function failure(error: unknown) {
  if (error instanceof PartnerAdminError) {
    if (error.kind === 'conflict')
      return t(
        'Access changed while you were editing. Refresh this account and review its current access before trying again.',
      );
    if (error.code === 'HOSTING_EXISTING_CLIENT_MEMBERSHIP')
      return t(
        'This account already has an independent membership in that workspace. It was preserved; no partner assignment was added.',
      );
    if (error.code === 'HOSTING_VERIFIED_IDENTITY_REQUIRED')
      return t(
        'Email verification is required. Ask this person to verify their account, then find it again.',
      );
    if (error.kind === 'denied' || error.kind === 'session')
      return t(
        'This action is not permitted with the current account or session. Refresh to check operator access.',
      );
  }
  return t(
    'The change was not confirmed. Refresh this account to check its saved access before trying again.',
  );
}
export function PartnersAdminPage() {
  const access = useHostedOperatorAccess();
  return <PartnerSession key={access.session.epoch} access={access} />;
}
function PartnerSession({ access }: { access: Access }) {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [candidate, setCandidate] = useState<PartnerCandidate | null>(null);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [clientCursors, setClientCursors] = useState<(string | null)[]>([null]);
  const mounted = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const list = useQuery(
    partnersQuery(access.session, cursors[cursors.length - 1], access.allowed),
  );
  const clients = useQuery(
    operatorClientsQuery(
      access.session,
      clientCursors[clientCursors.length - 1],
      access.allowed,
    ),
  );
  const available =
    clients.data?.clients.filter(
      (item) =>
        !candidate?.workspaces.some(
          (home) => home.platformId === item.platformId,
        ) &&
        !candidate?.assignments.some(
          (assignment) =>
            assignment.platformId === item.platformId && assignment.active,
        ),
    ) ?? [];
  const chosen = available.some((item) => item.platformId === workspace);
  function select(value: PartnerCandidate) {
    setCandidate(value);
    setEmail(value.email);
    setSearched(true);
    setError(null);
    setNotice(null);
    setConfirmDeactivate(false);
    setWorkspace('');
  }
  async function find(event?: FormEvent) {
    event?.preventDefault();
    if (locked.current || !access.allowed) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    setCandidate(null);
    setConfirmDeactivate(false);
    setWorkspace('');
    try {
      const response = await lookupPartner(
        access.session,
        email.trim().toLowerCase(),
      );
      if (mounted.current) {
        setCandidate(response.candidate);
        setSearched(true);
      }
    } catch (error) {
      if (mounted.current) setError(failure(error));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function change(
    operation: () => ReturnType<typeof decidePartner>,
    message: string,
  ) {
    if (locked.current || !access.allowed) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await operation();
      if (mounted.current) {
        setCandidate(response.candidate);
        setNotice(message);
        setConfirmDeactivate(false);
        setWorkspace('');
        void client.invalidateQueries({
          queryKey: ['hosted-partners', access.session.epoch],
        });
      }
    } catch (error) {
      if (mounted.current) {
        setError(failure(error));
        setConfirmDeactivate(false);
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold">{t('Partners')}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-11">
          {t(
            'Approve verified accounts, then assign the client workspaces they can support. Partner access is a separate operator decision from course enrollment or certification.',
          )}
        </p>
      </header>
      {!access.hosted || access.session.kind !== 'user' ? (
        <p role="status">
          {t(
            'Sign in to your hosted Sydekyks operator account to manage partners.',
          )}
        </p>
      ) : access.isPending ? (
        <p role="status">{t('Checking operator access…')}</p>
      ) : !access.allowed ? (
        <p role="alert">
          {t(
            'Only configured Sydekyks operators can manage partners. Client administrators and partners cannot approve access.',
          )}
        </p>
      ) : (
        <>
          <section aria-labelledby="add-partner-heading" className="max-w-3xl">
            <h2 id="add-partner-heading" className="text-lg font-semibold">
              {t('Add partner')}
            </h2>
            <p className="mt-2 text-sm leading-6 text-gray-11">
              {t(
                'Find an existing account by its exact email. For a new account, share the signup link and ask the person to complete email verification first. They can then wait for your approval; they do not need to sign up again.',
              )}
            </p>
            <p className="mt-2 text-sm leading-6 text-gray-11">
              {t(
                'This page does not send invitations. New accounts require working email verification; if it is unavailable, configure it before sharing the signup link.',
              )}
            </p>
            <p className="mt-3 text-sm">
              <a
                className="text-primary underline underline-offset-4"
                href={new URL('/sign-up', window.location.origin).href}
                target="_blank"
                rel="noreferrer"
              >
                {t('Open secure account signup')}
              </a>
            </p>
            <form
              onSubmit={find}
              className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="min-w-0 flex-1">
                <label htmlFor="partner-email" className="text-sm font-medium">
                  {t('Account email')}
                </label>
                <Input
                  id="partner-email"
                  className="mt-2"
                  type="email"
                  autoComplete="off"
                  required
                  maxLength={254}
                  value={email}
                  disabled={busy}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <Button type="submit" disabled={busy} aria-busy={busy}>
                {busy ? t('Please wait…') : t('Find account')}
              </Button>
            </form>
          </section>
          <div aria-live="polite" className="space-y-2">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-sm">
                {notice}
              </p>
            )}
            {searched && !candidate && !busy && !error && (
              <p className="text-sm">
                {t(
                  'No account was found. Share the secure signup link, then search again after email verification.',
                )}
              </p>
            )}
          </div>
          {candidate && (
            <section
              aria-labelledby="partner-account-heading"
              className="border-t border-gray-6 pt-6"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2
                    id="partner-account-heading"
                    className="break-words text-lg font-semibold"
                  >
                    {name(candidate)}
                  </h2>
                  <p className="mt-1 break-all text-sm text-gray-11">
                    {candidate.email}
                  </p>
                  <p className="mt-2 text-sm">
                    {candidate.verified
                      ? t('Email verified')
                      : t('Email verification pending')}
                    {' · '}
                    {candidate.role === 'partner'
                      ? candidate.active
                        ? t('Partner active')
                        : t('Partner inactive')
                      : candidate.role === 'team'
                      ? t('Sydekyks team account')
                      : t('Partner approval pending')}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void find()}
                >
                  {t('Refresh account')}
                </Button>
              </div>
              {!candidate.verified ? (
                <p className="mt-4 text-sm">
                  {t(
                    'Approval is unavailable until this person verifies their email through the secure signup flow.',
                  )}
                </p>
              ) : !candidate.editable ? (
                <p className="mt-4 text-sm">
                  {t(
                    'This protected account cannot be changed into a partner here. Operator and team access are managed separately.',
                  )}
                </p>
              ) : (
                <>
                  {candidate.role === 'partner' && candidate.active ? (
                    <div className="mt-5 space-y-3">
                      <p className="max-w-3xl text-sm leading-6 text-gray-11">
                        {t(
                          'Deactivating revokes all operational client assignments and existing operational sessions. Independent account memberships remain unchanged.',
                        )}
                      </p>
                      {confirmDeactivate ? (
                        <div className="flex flex-wrap items-center gap-3">
                          <Button
                            variant="destructive"
                            disabled={busy}
                            onClick={() =>
                              void change(
                                () =>
                                  decidePartner(
                                    access.session,
                                    candidate,
                                    false,
                                  ),
                                t(
                                  'Partner deactivated. Operational client access and its existing sessions have been revoked.',
                                ),
                              )
                            }
                          >
                            {t('Confirm deactivation')}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setConfirmDeactivate(false)}
                          >
                            {t('Keep active')}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => setConfirmDeactivate(true)}
                        >
                          {t('Deactivate partner')}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="mt-5 space-y-3">
                      <p className="max-w-3xl text-sm leading-6 text-gray-11">
                        {t(
                          'Approval creates a sign-in workspace if needed and preserves existing independent memberships. It does not award certification, enroll in training or assign client access.',
                        )}
                      </p>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void change(
                            () =>
                              decidePartner(access.session, candidate, true),
                            t(
                              'Partner approved. Ask them to sign in again. Assign client workspaces below when they are ready.',
                            ),
                          )
                        }
                      >
                        {t('Approve partner')}
                      </Button>
                    </div>
                  )}
                  {candidate.role === 'partner' && candidate.active && (
                    <section
                      aria-labelledby="partner-workspaces-heading"
                      className="mt-8 max-w-3xl"
                    >
                      <h3
                        id="partner-workspaces-heading"
                        className="text-base font-semibold"
                      >
                        {t('Client workspace assignments')}
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-gray-11">
                        {t(
                          'Assignments give this partner operational access without a client invitation. Removing an assignment revokes existing operational sessions for that access.',
                        )}
                      </p>
                      <ul className="mt-4 divide-y divide-gray-6">
                        {candidate.assignments
                          .filter((item) => item.active)
                          .map((item) => (
                            <li
                              key={item.platformId}
                              className="flex flex-wrap items-center justify-between gap-3 py-3"
                            >
                              <span className="min-w-0 break-words text-sm">
                                {item.name}
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                aria-label={t('Remove access to {name}', {
                                  name: item.name,
                                })}
                                onClick={() =>
                                  void change(
                                    () =>
                                      assignPartner(
                                        access.session,
                                        candidate,
                                        item.platformId,
                                        false,
                                      ),
                                    t(
                                      'Workspace assignment removed. Existing operational sessions for that access have been revoked.',
                                    ),
                                  )
                                }
                              >
                                {t('Remove access')}
                              </Button>
                            </li>
                          ))}
                      </ul>
                      {!candidate.assignments.some((item) => item.active) && (
                        <p className="mt-4 text-sm text-gray-11">
                          {t(
                            'No client workspaces assigned. Choose a named workspace below to grant access.',
                          )}
                        </p>
                      )}
                      <label
                        htmlFor="partner-client"
                        className="mt-5 block text-sm font-medium"
                      >
                        {t('Client workspace')}
                      </label>
                      <select
                        id="partner-client"
                        className={selectStyle}
                        value={chosen ? workspace : ''}
                        disabled={busy || clients.isFetching}
                        onChange={(event) => setWorkspace(event.target.value)}
                      >
                        <option value="">
                          {t('Choose a client workspace')}
                        </option>
                        {available.map((item) => (
                          <option key={item.platformId} value={item.platformId}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                      {clients.isError && (
                        <p role="alert" className="mt-3 text-sm">
                          {t(
                            'Client names could not load. Refresh the client list to try again.',
                          )}
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-3">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            busy ||
                            clients.isFetching ||
                            clientCursors.length === 1
                          }
                          onClick={() => {
                            setClientCursors((values) => values.slice(0, -1));
                            setWorkspace('');
                          }}
                        >
                          {t('Previous clients')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            busy || clients.isFetching || !clients.data?.next
                          }
                          onClick={() => {
                            setClientCursors((values) => [
                              ...values,
                              clients.data?.next ?? null,
                            ]);
                            setWorkspace('');
                          }}
                        >
                          {t('More clients')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || clients.isFetching}
                          onClick={() => void clients.refetch()}
                        >
                          {t('Refresh client list')}
                        </Button>
                      </div>
                      <Button
                        className="mt-4"
                        disabled={busy || !chosen}
                        onClick={() =>
                          void change(
                            () =>
                              assignPartner(
                                access.session,
                                candidate,
                                workspace,
                                true,
                              ),
                            t(
                              'Client workspace assigned. The partner can sign in and open it from Partner workspaces.',
                            ),
                          )
                        }
                      >
                        {t('Assign workspace')}
                      </Button>
                    </section>
                  )}
                </>
              )}
              {candidate.role === 'partner' && (
                <p className="mt-5 text-sm text-gray-11">
                  {t('Partners open assigned clients from')}{' '}
                  <Link
                    className="text-primary underline underline-offset-4"
                    to="/partners/workspaces"
                  >
                    {t('Partner workspaces')}
                  </Link>
                  .
                </p>
              )}
            </section>
          )}
          <section
            aria-labelledby="partner-directory-heading"
            className="border-t border-gray-6 pt-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2
                id="partner-directory-heading"
                className="text-lg font-semibold"
              >
                {t('Partner directory')}
              </h2>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || list.isFetching}
                onClick={() => void list.refetch()}
              >
                {t('Refresh directory')}
              </Button>
            </div>
            {list.isPending ? (
              <p role="status" className="mt-4 text-sm">
                {t('Loading partners…')}
              </p>
            ) : list.isError ? (
              <p role="alert" className="mt-4 text-sm">
                {t(
                  'The partner directory could not load. Refresh to check your access and try again.',
                )}
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-gray-6">
                {list.data?.partners.map((item) => (
                  <li
                    key={item.identityId}
                    className="flex flex-wrap items-center justify-between gap-3 py-4"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">
                        {name(item)}
                      </p>
                      <p className="mt-1 break-all text-sm text-gray-11">
                        {item.email}
                      </p>
                      <p className="mt-1 text-sm text-gray-11">
                        {item.active
                          ? t('Active partner')
                          : t('Inactive partner')}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => select(item)}
                      aria-label={t('Manage {email}', { email: item.email })}
                    >
                      {t('Manage')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {!list.isPending &&
              !list.isError &&
              !list.data?.partners.length && (
                <p className="mt-4 text-sm text-gray-11">
                  {t(
                    'No partners on this page. Find a verified account above to approve your first partner.',
                  )}
                </p>
              )}
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || list.isFetching || cursors.length === 1}
                onClick={() => setCursors((values) => values.slice(0, -1))}
              >
                {t('Previous partners')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || list.isFetching || !list.data?.next}
                onClick={() =>
                  setCursors((values) => [...values, list.data?.next ?? null])
                }
              >
                {t('More partners')}
              </Button>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
