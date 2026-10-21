import { useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { ManualAccountForm } from './manual-account-form';
import { operatorClientsQuery, useHostedOperatorAccess } from './operator-api';
import { PartnerSetupControls } from './partner-setup-controls';
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
        'Account setup is required. Share a private setup link or ask this person to complete email verification, then find the account again.',
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
  const [view, setView] = useState<'directory' | 'add' | 'setup'>('directory');
  const [directorySearch, setDirectorySearch] = useState('');
  const [directoryStatus, setDirectoryStatus] = useState<
    'all' | 'active' | 'pending' | 'inactive'
  >('all');
  const [filters, setFilters] = useState({
    search: '',
    status: 'all' as 'all' | 'active' | 'pending' | 'inactive',
  });
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
    partnersQuery(
      access.session,
      cursors[cursors.length - 1],
      access.allowed,
      filters,
    ),
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
    setView('directory');
    setCandidate(value);
    setEmail(value.email);
    setSearched(true);
    setError(null);
    setNotice(null);
    setConfirmDeactivate(false);
    setWorkspace('');
  }
  async function find(
    event?: FormEvent,
    address = email,
    successNotice?: string,
  ) {
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
        address.trim().toLowerCase(),
      );
      if (mounted.current) {
        setCandidate(response.candidate);
        setSearched(true);
        if (response.candidate?.verified) setView('directory');
        if (successNotice) setNotice(successNotice);
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
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold">{t('Partners')}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-11">
          {t('Onboard Partners, review their status and manage client access.')}
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
          <nav
            aria-label="Partner administration"
            className="flex flex-wrap gap-2 border-b border-gray-6 pb-4"
          >
            {(
              [
                { id: 'directory', label: 'Directory' },
                { id: 'add', label: 'Add Partner' },
                { id: 'setup', label: 'Setup links' },
              ] as const
            ).map((tab) => (
              <Button
                key={tab.id}
                variant={view === tab.id ? 'default' : 'ghost'}
                disabled={busy}
                aria-current={view === tab.id ? 'page' : undefined}
                onClick={() => {
                  setView(tab.id);
                  setCandidate(null);
                  setSearched(false);
                  setError(null);
                  setNotice(null);
                  setConfirmDeactivate(false);
                }}
              >
                {t(tab.label)}
              </Button>
            ))}
          </nav>
          {view === 'add' && (
            <ManualAccountForm
              session={access.session}
              kind="partner"
              onCreated={(account) => {
                setEmail(account.email);
                void list.refetch();
                void clients.refetch();
                void find(
                  undefined,
                  account.email,
                  t(
                    'Partner account created. Review their saved access below.',
                  ),
                );
              }}
            />
          )}
          {view === 'setup' && (
            <section
              aria-labelledby="add-partner-heading"
              className="max-w-3xl"
            >
              <h2 id="add-partner-heading" className="text-lg font-semibold">
                {t('Let a Partner choose their password')}
              </h2>
              <p className="mt-2 text-sm leading-6 text-gray-11">
                {t(
                  'Find their email to create a private setup link or open an existing account. To set an initial password and hosting term yourself, choose Add Partner.',
                )}
              </p>
              <p className="mt-2 text-sm leading-6 text-gray-11">
                {t(
                  'Share the one-time link privately. No email service is required.',
                )}
              </p>

              <form
                onSubmit={find}
                className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
              >
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor="partner-email"
                    className="text-sm font-medium"
                  >
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
          )}
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
                  'No account was found. Create a private setup link below, or use secure signup if email verification is available.',
                )}
              </p>
            )}
          </div>
          {view === 'setup' &&
            searched &&
            !error &&
            (!candidate ||
              (!candidate.verified &&
                candidate.editable &&
                candidate.role === null)) && (
              <PartnerSetupControls
                key={candidate?.email ?? email.trim().toLowerCase()}
                session={access.session}
                email={candidate?.email ?? email.trim().toLowerCase()}
                onChanged={() => {
                  void client.invalidateQueries({
                    queryKey: ['hosted-partners', access.session.epoch],
                  });
                }}
              />
            )}
          {view === 'directory' && candidate && (
            <section
              aria-labelledby="partner-account-heading"
              className="border-t border-gray-6 pt-6"
            >
              <div className="mb-5 flex flex-wrap items-center gap-3">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setCandidate(null);
                    setSearched(false);
                    setError(null);
                    setNotice(null);
                  }}
                >
                  {t('Back to directory')}
                </Button>
                <Button variant="outline" asChild>
                  <Link to="/learn">{t('Manage training')}</Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link to="/platform/billing/subscriptions">
                    {t('Hosting & renewal dates')}
                  </Link>
                </Button>
              </div>
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
                  <p className="mt-2 text-sm font-medium">
                    {candidate.workspaces
                      .map((item) => item.name)
                      .join(' · ') || t('No workspace yet')}
                  </p>
                  <p className="mt-2 text-sm">
                    {candidate.verificationMethod === 'operator'
                      ? candidate.admissionSource === 'trainer'
                        ? t('Trainer admitted')
                        : candidate.admissionSource === 'tenant_admin'
                        ? t('Client admin admitted')
                        : t('Operator admitted')
                      : candidate.verificationMethod === 'email' &&
                        candidate.emailOwnershipVerified
                      ? t('Email verified')
                      : t('Account setup pending')}
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
                    'Approval is unavailable until this person completes a private setup link or secure email verification.',
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
          {view === 'directory' && !candidate && (
            <section aria-labelledby="partner-directory-heading">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2
                    id="partner-directory-heading"
                    className="text-lg font-semibold"
                  >
                    {t('Partner directory')}
                  </h2>
                  <p className="mt-1 text-sm text-gray-11">
                    {t(
                      'Search by person, company or email. Open a Partner to manage their access.',
                    )}
                  </p>
                </div>
                <Button disabled={busy} onClick={() => setView('add')}>
                  {t('Add Partner')}
                </Button>
              </div>
              <form
                className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  setCursors([null]);
                  setFilters({
                    search: directorySearch.trim(),
                    status: directoryStatus,
                  });
                }}
              >
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor="partner-directory-search"
                    className="text-sm font-medium"
                  >
                    {t('Search Partners')}
                  </label>
                  <Input
                    id="partner-directory-search"
                    type="search"
                    className="mt-2"
                    maxLength={120}
                    value={directorySearch}
                    onChange={(event) => setDirectorySearch(event.target.value)}
                    placeholder={t('Name, company or email')}
                  />
                </div>
                <div>
                  <label
                    htmlFor="partner-directory-status"
                    className="text-sm font-medium"
                  >
                    {t('Access status')}
                  </label>
                  <select
                    id="partner-directory-status"
                    className={selectStyle}
                    value={directoryStatus}
                    onChange={(event) =>
                      setDirectoryStatus(
                        event.target.value as typeof directoryStatus,
                      )
                    }
                  >
                    <option value="all">{t('All statuses')}</option>
                    <option value="active">{t('Active')}</option>
                    <option value="pending">{t('Awaiting approval')}</option>
                    <option value="inactive">{t('Inactive')}</option>
                  </select>
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={list.isFetching}
                >
                  {t('Search')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={list.isFetching}
                  onClick={() => void list.refetch()}
                >
                  {t('Refresh')}
                </Button>
              </form>
              {list.isPending ? (
                <p role="status" className="py-8 text-sm">
                  {t('Loading Partners…')}
                </p>
              ) : list.isError ? (
                <div role="alert" className="py-8 text-sm">
                  <p>
                    {t(
                      'The directory could not load. Refresh to check your access and try again.',
                    )}
                  </p>
                </div>
              ) : !list.data?.partners.length ? (
                <div className="py-10 text-sm">
                  <p className="font-medium">
                    {filters.search || filters.status !== 'all'
                      ? t('No Partners match these filters.')
                      : t('No Partners yet.')}
                  </p>
                  <p className="mt-2 text-gray-11">
                    {filters.search || filters.status !== 'all'
                      ? t('Try another name, company or status.')
                      : t(
                          'Add your first Partner, or create a private setup link.',
                        )}
                  </p>
                </div>
              ) : (
                <div className="mt-5 overflow-x-auto rounded-md border border-gray-6">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">
                      {t('Partners and their operational client access')}
                    </caption>
                    <thead className="bg-gray-2 text-xs text-gray-11">
                      <tr>
                        <th scope="col" className="p-3 font-medium">
                          {t('Partner')}
                        </th>
                        <th
                          scope="col"
                          className="hidden p-3 font-medium md:table-cell"
                        >
                          {t('Company / workspace')}
                        </th>
                        <th scope="col" className="p-3 font-medium">
                          {t('Access')}
                        </th>
                        <th
                          scope="col"
                          className="hidden p-3 font-medium md:table-cell"
                        >
                          {t('Clients')}
                        </th>
                        <th scope="col" className="p-3">
                          <span className="sr-only">{t('Actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-6">
                      {list.data.partners.map((item) => (
                        <tr key={item.identityId}>
                          <th
                            scope="row"
                            className="max-w-[240px] p-3 font-normal"
                          >
                            <span className="block break-words font-medium">
                              {name(item)}
                            </span>
                            <span className="mt-1 block break-all text-xs text-gray-11">
                              {item.email}
                            </span>
                            <span className="mt-1 block break-words text-xs text-gray-11 md:hidden">
                              {item.workspaces[0]?.name ??
                                t('No workspace yet')}
                            </span>
                          </th>
                          <td className="hidden max-w-[200px] break-words p-3 md:table-cell">
                            {item.workspaces[0]?.name ?? t('No workspace yet')}
                          </td>
                          <td className="p-3">
                            <span className="text-xs">
                              {item.role !== 'partner'
                                ? t('Awaiting approval')
                                : item.active
                                ? t('Active')
                                : t('Inactive')}
                            </span>
                          </td>
                          <td className="hidden p-3 tabular-nums md:table-cell">
                            {
                              item.assignments.filter(
                                (assignment) => assignment.active,
                              ).length
                            }
                          </td>
                          <td className="p-3 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => select(item)}
                              aria-label={t('Manage {email}', {
                                email: item.email,
                              })}
                            >
                              {t('Manage')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-gray-11" aria-live="polite">
                  {list.data
                    ? `${list.data.total ?? list.data.partners.length} ${t(
                        'Partners found',
                      )} · ${t('Page')} ${cursors.length}`
                    : ''}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || list.isFetching || cursors.length === 1}
                    onClick={() => setCursors((values) => values.slice(0, -1))}
                  >
                    {t('Previous')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || list.isFetching || !list.data?.next}
                    onClick={() =>
                      setCursors((values) => [
                        ...values,
                        list.data?.next ?? null,
                      ])
                    }
                  >
                    {t('Next')}
                  </Button>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
