import { useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  acceptHostedResponse,
  assertAuthSession,
} from '@/features/hosted-onboarding/auth-session';

import { operatorClientsQuery, useHostedOperatorAccess } from './operator-api';
import { lookupPartner, PartnerCandidate } from './partners-api';
import {
  assignTrainer,
  decideTrainer,
  enterTrainerClient,
  listTrainers,
  Portfolio,
  Trainer,
  trainerPrecondition,
  trainerRequest,
  usePlatformTrainerAccess,
} from './trainers-api';

const selectStyle =
  'h-10 w-full rounded-md border border-gray-6 bg-gray-1 px-3 text-sm';
export function TrainersAdminPage() {
  const access = useHostedOperatorAccess();
  return <Admin key={access.session.epoch} access={access} />;
}
function Admin({
  access,
}: {
  access: ReturnType<typeof useHostedOperatorAccess>;
}) {
  const [candidate, setCandidate] = useState<Trainer | null>(null),
    [partner, setPartner] = useState<PartnerCandidate | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const alive = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const list = useQuery({
    queryKey: ['platform-trainers', access.session.epoch],
    queryFn: ({ signal }) => listTrainers(access.session, undefined, signal),
    enabled: access.allowed,
    retry: false,
    gcTime: 0,
  });
  const clients = useQuery(
    operatorClientsQuery(access.session, null, access.allowed),
  );
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch {
      try {
        assertAuthSession(access.session);
        if (alive.current)
          setError(
            t(
              'This action could not be confirmed. Refresh and check current access before trying again.',
            ),
          );
      } catch {
        /* obsolete session */
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function decision(active: boolean) {
    if (
      !candidate ||
      !window.confirm(
        active
          ? t('Grant Trainer access to this account? They must sign in again.')
          : t(
              'Deactivate this Trainer and all portfolio assignments? Learners keep their course access.',
            ),
      )
    )
      return;
    await run(async () => {
      const result = await decideTrainer(access.session, candidate, active);
      if (!alive.current) return;
      setCandidate(result.trainer);
      setNotice(t('Trainer access updated. The Trainer must sign in again.'));
      void list.refetch();
    });
  }
  async function assign(input: Parameters<typeof assignTrainer>[2]) {
    if (
      !candidate ||
      !window.confirm(
        t(
          'Update this Trainer portfolio assignment? Removed access takes effect immediately.',
        ),
      )
    )
      return;
    await run(async () => {
      const result = await assignTrainer(access.session, candidate, input);
      if (!alive.current) return;
      setCandidate(result.trainer);
      setNotice(
        t(
          'Portfolio updated. Removed assignments invalidate the Trainer’s previous session.',
        ),
      );
      void list.refetch();
    });
  }
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 sm:p-8">
      <header>
        <h1 className="text-2xl font-semibold">{t('Platform Trainers')}</h1>
        <p className="mt-2 max-w-prose text-sm leading-6 text-gray-11">
          {t(
            'Delegate onboarding and teaching for a named portfolio. Trainers cannot approve Partner qualifications, assess practical work, change Sydekyks connections or manage payments and credits.',
          )}
        </p>
      </header>
      {!access.allowed ? (
        <p role="status">
          {access.isPending
            ? t('Checking access…')
            : t('Only authorized Sydekyks administrators can manage Trainers.')}
        </p>
      ) : (
        <>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const email = String(
                new FormData(event.currentTarget).get('email'),
              );
              setCandidate(null);
              setPartner(null);
              void run(async () => {
                const result = await listTrainers(access.session, email);
                if (alive.current) {
                  setCandidate(result.trainers[0] ?? null);
                  if (!result.trainers.length)
                    setNotice(
                      t(
                        'No account was found. Complete normal account setup and create an owned workspace before granting Trainer access.',
                      ),
                    );
                }
              });
            }}
          >
            <div className="min-w-0 flex-1">
              <label htmlFor="trainer-email" className="text-sm font-medium">
                {t('Existing account email')}
              </label>
              <Input
                className="mt-2"
                id="trainer-email"
                name="email"
                type="email"
                required
                maxLength={254}
                disabled={busy}
              />
            </div>
            <Button disabled={busy}>{t('Find account')}</Button>
          </form>
          {candidate && (
            <section
              aria-labelledby="trainer-detail"
              className="space-y-5 rounded-xl border p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <h2
                    id="trainer-detail"
                    className="break-words text-lg font-semibold"
                  >
                    {candidate.name || candidate.email}
                  </h2>
                  <p className="break-all text-sm text-gray-11">
                    {candidate.email}
                  </p>
                  <p className="mt-2 text-sm">
                    {candidate.active
                      ? t('Trainer active')
                      : t('Trainer inactive')}{' '}
                    ·{' '}
                    {candidate.verified
                      ? t('Account ready')
                      : t('Account setup pending')}
                  </p>
                </div>
                <Button
                  variant={candidate.active ? 'outline' : 'default'}
                  disabled={busy || !candidate.verified}
                  onClick={() => void decision(!candidate.active)}
                >
                  {candidate.active
                    ? t('Deactivate Trainer')
                    : t('Grant Trainer access')}
                </Button>
              </div>
              {candidate.active && (
                <>
                  <form
                    className="space-y-3 border-t pt-5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setPartner(null);
                      const email = String(
                        new FormData(event.currentTarget).get('email'),
                      );
                      void run(async () => {
                        const result = await lookupPartner(
                          access.session,
                          email,
                        );
                        if (alive.current) {
                          setPartner(result.candidate);
                          if (!result.candidate)
                            setNotice(t('No eligible account was found.'));
                        }
                      });
                    }}
                  >
                    <label
                      htmlFor="trainer-partner"
                      className="text-sm font-medium"
                    >
                      {t('Assign an existing Partner learner')}
                    </label>
                    <div className="flex flex-wrap gap-3">
                      <Input
                        id="trainer-partner"
                        name="email"
                        type="email"
                        required
                        maxLength={254}
                        className="min-w-0 flex-1"
                        disabled={busy}
                      />
                      <Button variant="outline" disabled={busy}>
                        {t('Find learner')}
                      </Button>
                    </div>
                  </form>
                  {partner && (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="break-all text-sm">
                        {partner.firstName} {partner.lastName} · {partner.email}
                      </span>
                      <Button
                        disabled={busy || !partner.verified}
                        onClick={() =>
                          void assign({
                            kind: 'partner',
                            targetId: partner.identityId,
                            active: true,
                          })
                        }
                      >
                        {t('Assign learner')}
                      </Button>
                    </div>
                  )}
                  <form
                    className="flex flex-wrap items-end gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const platformId = String(
                        new FormData(event.currentTarget).get('client'),
                      );
                      if (
                        clients.data?.clients.some(
                          (c) => c.platformId === platformId,
                        )
                      )
                        void assign({
                          kind: 'client',
                          targetId: platformId,
                          active: true,
                        });
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <label
                        htmlFor="trainer-client"
                        className="text-sm font-medium"
                      >
                        {t('Assign a client workspace')}
                      </label>
                      <select
                        id="trainer-client"
                        name="client"
                        className={'mt-2 ' + selectStyle}
                        required
                        disabled={busy || !clients.data}
                      >
                        <option value="">
                          {t('Choose a named workspace')}
                        </option>
                        {clients.data?.clients.map((client) => (
                          <option
                            key={client.platformId}
                            value={client.platformId}
                          >
                            {client.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button disabled={busy || !clients.data}>
                      {t('Assign workspace')}
                    </Button>
                  </form>
                  {clients.data?.next && (
                    <p className="text-sm text-gray-11">
                      {t(
                        'This list shows the first 100 workspaces. Contact support if your client is not listed.',
                      )}
                    </p>
                  )}
                </>
              )}
              <h3 className="pt-3 text-sm font-semibold">
                {t('Portfolio assignments')}
              </h3>
              <ul className="divide-y">
                {candidate.assignments.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">
                        {item.name}
                      </p>
                      <p className="text-sm text-gray-11">
                        {item.kind === 'client'
                          ? t('Client workspace')
                          : item.kind === 'recipient'
                          ? t('Account setup')
                          : t('Partner learner')}{' '}
                        · {item.active ? t('Active') : t('Removed')}
                      </p>
                    </div>
                    {item.active && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void assign({ assignmentId: item.id, active: false })
                        }
                      >
                        {t('Remove assignment')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {!candidate.assignments.length && (
                <p className="text-sm text-gray-11">
                  {t(
                    'Assign a learner or client to define this Trainer’s scope.',
                  )}
                </p>
              )}
            </section>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger-11">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
          <section>
            <h2 className="text-lg font-semibold">{t('Trainer directory')}</h2>
            {list.isPending ? (
              <p role="status" className="mt-4 text-sm">
                {t('Loading Trainers…')}
              </p>
            ) : list.error ? (
              <Button variant="outline" onClick={() => void list.refetch()}>
                {t('Reload Trainers')}
              </Button>
            ) : (
              <ul className="mt-3 divide-y">
                {list.data?.trainers.map((item) => (
                  <li
                    key={item.identityId}
                    className="flex flex-wrap items-center justify-between gap-3 py-4"
                  >
                    <div className="min-w-0">
                      <p className="break-words font-medium">
                        {item.name || item.email}
                      </p>
                      <p className="break-all text-sm text-gray-11">
                        {item.email} ·{' '}
                        {item.active ? t('Active') : t('Inactive')}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setCandidate(item);
                        setPartner(null);
                      }}
                    >
                      {t('Manage Trainer')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {list.data?.trainers.length === 0 && (
              <p className="mt-4 text-sm text-gray-11">
                {t(
                  'No Trainers yet. Find an existing account above to grant access.',
                )}
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}

export function TrainerWorkspacePage() {
  const access = usePlatformTrainerAccess();
  return <Workspace key={access.session.epoch} access={access} />;
}
function Workspace({
  access,
}: {
  access: ReturnType<typeof usePlatformTrainerAccess>;
}) {
  const query = useQuery({
    queryKey: ['trainer-portfolio', access.session.epoch],
    queryFn: ({ signal }) =>
      trainerRequest(
        access.session,
        '/trainer/portfolio',
        Portfolio,
        undefined,
        signal,
      ),
    enabled: access.allowed,
    retry: false,
    gcTime: 0,
  });
  const [data, setData] = useState<Portfolio | null>(null),
    [url, setUrl] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  const cache = useQueryClient(),
    navigate = useNavigate(),
    alive = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (query.data) setData(query.data);
  }, [query.data]);
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setUrl(null);
    setCopied(false);
    try {
      await action();
    } catch {
      try {
        assertAuthSession(access.session);
        if (alive.current)
          setError(
            t(
              'This action could not be confirmed. Refresh your portfolio before continuing.',
            ),
          );
      } catch {
        /* obsolete session */
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function command(path: string, input: Record<string, unknown>) {
    if (!data) return;
    await run(async () => {
      const result = await trainerRequest(access.session, path, Portfolio, {
        ...trainerPrecondition(data),
        ...input,
      });
      if (alive.current) {
        setData(result);
        setUrl(result.setupUrl ?? null);
      }
    });
  }
  function onboard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      fields = new FormData(form),
      email = String(fields.get('email')),
      kind = String(fields.get('kind')),
      workspaceName = String(fields.get('workspaceName'));
    if (
      !window.confirm(
        t(
          'Create a brand-new account and one-time setup link for this recipient? Existing accounts cannot be claimed.',
        ),
      )
    )
      return;
    void command('/trainer/onboard', { email, kind, workspaceName });
  }
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 p-4 sm:p-8">
      <header>
        <Button variant="ghost" asChild>
          <Link to="/">{t('Back to workspace')}</Link>
        </Button>
        <h1 className="mt-5 text-2xl font-semibold">
          {t('Trainer workspace')}
        </h1>
        <p className="mt-2 max-w-prose text-sm leading-6 text-gray-11">
          {t(
            'Onboard and teach the learners and clients assigned to you. Partner approval, assessments, payments and Sydekyks connection settings remain with the Sydekyks team.',
          )}
        </p>
      </header>
      {!access.allowed ? (
        <p role="status">
          {access.isPending
            ? t('Checking Trainer access…')
            : t(
                'A current Trainer role and portfolio assignment are required. Ask the Sydekyks team for access.',
              )}
        </p>
      ) : query.isPending ? (
        <p role="status">{t('Loading your portfolio…')}</p>
      ) : query.error ? (
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t('Reload portfolio')}
        </Button>
      ) : (
        <>
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">
              {t('Onboard a new recipient')}
            </h2>
            <p className="max-w-prose text-sm leading-6 text-gray-11">
              {t(
                'Use a brand-new account email. The recipient chooses their own password from a private 24-hour setup link. Existing accounts must be assigned by Sydekyks. A Partner learner still needs separate Partner approval; no paid training or assessment allowance is granted here.',
              )}
            </p>
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={onboard}>
              <div>
                <label
                  htmlFor="recipient-email"
                  className="text-sm font-medium"
                >
                  {t('Recipient email')}
                </label>
                <Input
                  id="recipient-email"
                  name="email"
                  className="mt-2"
                  type="email"
                  required
                  maxLength={254}
                  disabled={busy}
                />
              </div>
              <div>
                <label htmlFor="recipient-kind" className="text-sm font-medium">
                  {t('Recipient type')}
                </label>
                <select
                  id="recipient-kind"
                  name="kind"
                  className={'mt-2 ' + selectStyle}
                  disabled={busy}
                >
                  <option value="partner">{t('Partner learner')}</option>
                  <option value="client">{t('Client owner')}</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label
                  htmlFor="recipient-workspace"
                  className="text-sm font-medium"
                >
                  {t('New workspace name')}
                </label>
                <Input
                  id="recipient-workspace"
                  name="workspaceName"
                  className="mt-2"
                  required
                  maxLength={120}
                  disabled={busy}
                />
              </div>
              <Button className="sm:justify-self-start" disabled={busy}>
                {busy ? t('Saving…') : t('Create setup link')}
              </Button>
            </form>
          </section>
          {url && (
            <section className="space-y-3 rounded-xl border p-5">
              <h2 className="font-semibold">{t('Private setup link')}</h2>
              <p className="text-sm leading-6 text-gray-11">
                {t(
                  'Share this link directly with the intended recipient. It appears once, expires after 24 hours and stops working if your access is removed. No email has been sent.',
                )}
              </p>
              <Input
                aria-label={t('Private setup link')}
                type="password"
                autoComplete="off"
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                value={url}
              />
              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(url)
                      .then(() => {
                        if (alive.current) setCopied(true);
                      })
                      .catch(() =>
                        setError(
                          t('Copy failed. Select and copy the link above.'),
                        ),
                      )
                  }
                >
                  {copied ? t('Copied') : t('Copy setup link')}
                </Button>
                <Button variant="outline" onClick={() => setUrl(null)}>
                  {t('Hide link')}
                </Button>
              </div>
            </section>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger-11">
              {error}
            </p>
          )}
          <section>
            <h2 className="text-lg font-semibold">
              {t('Pending account setup')}
            </h2>
            <ul className="mt-3 divide-y">
              {data?.pending.map((item) => (
                <li
                  key={item.assignmentId}
                  className="flex flex-wrap items-center justify-between gap-3 py-4"
                >
                  <div className="min-w-0">
                    <p className="break-all text-sm font-medium">
                      {item.email}
                    </p>
                    <p className="text-sm text-gray-11">
                      {item.kind === 'client'
                        ? t('Client owner')
                        : t('Partner learner')}{' '}
                      · {t('Link expires')}{' '}
                      {new Date(item.expiresAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            t(
                              'Replace the setup link? The previous link will stop working.',
                            ),
                          )
                        )
                          void command('/trainer/setup/replace', {
                            assignmentId: item.assignmentId,
                          });
                      }}
                    >
                      {t('Replace link')}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            t('Cancel this pending account setup?'),
                          )
                        )
                          void command('/trainer/setup/revoke', {
                            assignmentId: item.assignmentId,
                          });
                      }}
                    >
                      {t('Cancel setup')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {!data?.pending.length && (
              <p className="mt-3 text-sm text-gray-11">
                {t('No pending setup links.')}
              </p>
            )}
          </section>
          <section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">
                {t('Assigned Partner learners')}
              </h2>
              <Button variant="outline" asChild>
                <Link to="/learn">{t('Manage training courses')}</Link>
              </Button>
            </div>
            <ul className="mt-3 divide-y">
              {data?.partners.map((item) => (
                <li className="py-4" key={item.identityId}>
                  <p className="break-words font-medium">
                    {item.firstName} {item.lastName}
                  </p>
                  <p className="break-all text-sm text-gray-11">{item.email}</p>
                </li>
              ))}
            </ul>
            {!data?.partners.length && (
              <p className="mt-3 text-sm text-gray-11">
                {t('No Partner learners are assigned.')}
              </p>
            )}
          </section>
          <section>
            <h2 className="text-lg font-semibold">
              {t('Assigned client workspaces')}
            </h2>
            <ul className="mt-3 divide-y">
              {data?.clients.map((item) => (
                <li
                  key={item.platformId}
                  className="flex flex-wrap items-center justify-between gap-3 py-4"
                >
                  <p className="min-w-0 break-words font-medium">{item.name}</p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const response = await enterTrainerClient(
                          access.session,
                          item.platformId,
                        );
                        if (!alive.current) return;
                        acceptHostedResponse(response, access.session, () =>
                          cache.clear(),
                        );
                        navigate('/', { replace: true });
                      })
                    }
                  >
                    {t('Open workspace')}
                  </Button>
                </li>
              ))}
            </ul>
            {!data?.clients.length && (
              <p className="mt-3 text-sm text-gray-11">
                {t('No client workspaces are assigned.')}
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
