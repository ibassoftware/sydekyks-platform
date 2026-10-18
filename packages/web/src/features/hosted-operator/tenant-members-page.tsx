import { PlatformRole } from '@activepieces/shared';
import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { FormEvent, useRef, useState } from 'react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

const Member = z.object({
  id: z.string(),
  identityId: z.string(),
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  status: z.string(),
  platformRole: z.enum(PlatformRole),
  protected: z.boolean(),
  operational: z.boolean(),
  admissionSource: z.string(),
  emailOwnershipVerified: z.boolean(),
});
const List = z.object({
  platformId: z.string(),
  userId: z.string(),
  revision: z.number().int(),
  stateHash: z.string(),
  seats: z.object({
    used: z.number(),
    reserved: z.number(),
    limit: z.number(),
  }),
  members: z.array(Member),
  invitations: z.array(
    z.object({
      id: z.string(),
      email: z.string().nullable(),
      role: z.enum(PlatformRole),
      expiresAt: z.string(),
    }),
  ),
});
type Session = ReturnType<typeof useHostedAuthSession>;
const selectStyle =
  'rounded-md border border-gray-6 bg-gray-1 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-9';
function roleLabel(role: PlatformRole) {
  return role === PlatformRole.ADMIN
    ? t('Admin')
    : role === PlatformRole.MEMBER
    ? t('Member')
    : t('Operator — read shared projects');
}
function RoleOptions() {
  return (
    <>
      {Object.values(PlatformRole).map((role) => (
        <option key={role} value={role}>
          {roleLabel(role)}
        </option>
      ))}
    </>
  );
}
async function request(
  session: Session,
  path = '',
  data?: unknown,
  signal?: AbortSignal,
) {
  assertAuthSession(session);
  try {
    const raw = await api.sessionScoped<unknown>(
      '/v1/hosting/tenant-members' + path,
      { method: data ? 'POST' : 'GET', ...(data ? { data } : {}), signal },
    );
    assertAuthSession(session);
    const parsed = List.parse(raw);
    if (
      parsed.platformId !== session.platformId ||
      parsed.userId !== session.id
    )
      throw new Error('Session mismatch');
    const secret =
      z.object({ setupUrl: z.string().nullable().optional() }).parse(raw)
        .setupUrl ?? null;
    return { list: parsed, secret };
  } catch (error) {
    assertAuthSession(session);
    const code = api.isError(error)
      ? (error.response?.data as { code?: unknown })?.code
      : null;
    throw new Error(
      code === 'HOSTING_RESOURCE_LIMIT'
        ? 'capacity'
        : code === 'HOSTING_MEMBERS_REVISION_CONFLICT'
        ? 'conflict'
        : 'unavailable',
    );
  }
}
export function TenantMembersPage() {
  const session = useHostedAuthSession();
  return <MemberSession key={session.epoch} session={session} />;
}
function MemberSession({ session }: { session: Session }) {
  const [email, setEmail] = useState(''),
    [role, setRole] = useState<PlatformRole>(PlatformRole.MEMBER),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [url, setUrl] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false),
    serial = useRef(0);
  const query = useQuery({
    queryKey: ['tenant-members', session.epoch],
    queryFn: async ({ signal }) =>
      (await request(session, '', undefined, signal)).list,
    enabled: session.kind === 'user',
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  async function change(path: string, payload: Record<string, unknown>) {
    if (!query.data || lock.current) return;
    lock.current = true;
    const operation = ++serial.current;
    setBusy(true);
    setNotice(null);
    setUrl(null);
    try {
      const result = await request(session, path, {
        ...payload,
        expectedRevision: query.data.revision,
        expectedState: query.data.stateHash,
        requestKey: crypto.randomUUID(),
      });
      if (serial.current !== operation) return;
      if (result.secret) {
        const link = new URL(result.secret);
        if (
          link.origin !== window.location.origin ||
          link.pathname !== '/tenant-join' ||
          link.search ||
          !/^#token=[a-zA-Z0-9_-]{43}$/.test(link.hash)
        )
          throw new Error('unavailable');
        setUrl(result.secret);
      }
      setConfirmed(false);
      setNotice(
        result.secret
          ? t(
              'Private link created. Copy it now and share it with the intended person. It is not sent by email and cannot be retrieved later.',
            )
          : t(
              'Membership change saved. Existing access was rechecked by the server.',
            ),
      );
      await query.refetch();
    } catch (error) {
      if (serial.current === operation)
        setNotice(
          error instanceof Error && error.message === 'capacity'
            ? t(
                'This plan has no room for another user or personal project. Revoke an unused invitation, deactivate a user, or ask Sydekyks about a larger plan.',
              )
            : error instanceof Error && error.message === 'conflict'
            ? t(
                'Membership changed while you were editing. Refresh the list and review the current access before trying again.',
              )
            : t(
                'The change was not confirmed. Refresh the list before trying again; replacing a link invalidates the earlier invitation.',
              ),
        );
    } finally {
      lock.current = false;
      if (serial.current === operation) setBusy(false);
    }
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed) return;
    await change('/invite', { email: email.trim().toLowerCase(), role });
  }
  async function copy() {
    if (!url) return;
    try {
      assertAuthSession(session);
      await navigator.clipboard.writeText(url);
      assertAuthSession(session);
      setNotice(
        t(
          'Workspace link copied. Share it privately with the intended person.',
        ),
      );
    } catch {
      setNotice(
        t(
          'Clipboard access is unavailable. Select the private link field to copy it.',
        ),
      );
    }
  }
  return (
    <main className="p-4 md:p-8">
      <h1 className="text-2xl font-semibold">{t('Workspace users')}</h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-11">
        {t(
          'Invite people to this workspace with a private one-time link. Existing accounts use their current password; new accounts choose a password. Membership does not grant Partner status or start another trial.',
        )}
      </p>
      {query.isPending ? (
        <p role="status" className="mt-6 text-sm">
          {t('Checking workspace administration access…')}
        </p>
      ) : query.isError || !query.data ? (
        <p role="alert" className="mt-6 text-sm">
          {t(
            'User management is available to current workspace admins. Refresh or ask your workspace owner for access.',
          )}
        </p>
      ) : (
        <>
          <p className="mt-5 text-sm tabular-nums">
            {t(
              '{used} active users · {reserved} pending invitations · {limit} seats in this plan',
              query.data.seats,
            )}
          </p>
          <form
            onSubmit={invite}
            className="mt-7 max-w-3xl space-y-4 rounded-lg border border-gray-6 p-4"
          >
            <h2 className="text-lg font-semibold">
              {t('Add a workspace user')}
            </h2>
            <p className="text-sm leading-6 text-gray-11">
              {t(
                'Links work once and expire within 24 hours. A pending invitation reserves a seat and personal project. Creating a replacement for the same email revokes the earlier link.',
              )}
            </p>
            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="flex-1">
                <label
                  htmlFor="tenant-member-email"
                  className="text-sm font-medium"
                >
                  {t('Email')}
                </label>
                <Input
                  className="mt-2"
                  id="tenant-member-email"
                  type="email"
                  required
                  maxLength={254}
                  value={email}
                  disabled={busy}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </div>
              <div>
                <label
                  htmlFor="tenant-member-role"
                  className="block text-sm font-medium"
                >
                  {t('Workspace role')}
                </label>
                <select
                  className={'mt-2 w-full ' + selectStyle}
                  id="tenant-member-role"
                  value={role}
                  disabled={busy}
                  onChange={(event) => {
                    setRole(event.target.value as PlatformRole);
                    setConfirmed(false);
                  }}
                >
                  <RoleOptions />
                </select>
              </div>
            </div>
            <label className="flex items-start gap-3 text-sm leading-6">
              <input
                className="mt-1 size-4 accent-accent-9"
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                {t(
                  'I confirm this person should receive the selected workspace role, and I will share the link privately.',
                )}
              </span>
            </label>
            <Button
              type="submit"
              disabled={busy || !confirmed || query.isFetching}
            >
              {t('Create workspace link')}
            </Button>
          </form>
          {url && (
            <section
              className="mt-5 max-w-3xl"
              aria-label={t('Private workspace invitation')}
            >
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input
                  type="password"
                  aria-label={t('Private workspace link')}
                  readOnly
                  autoComplete="off"
                  value={url}
                  onFocus={(event) => event.target.select()}
                />
                <Button variant="outline" onClick={() => void copy()}>
                  {t('Copy workspace link')}
                </Button>
                <Button variant="ghost" onClick={() => setUrl(null)}>
                  {t('Hide link')}
                </Button>
              </div>
            </section>
          )}
          <section className="mt-9 max-w-5xl" aria-labelledby="current-users">
            <h2 id="current-users" className="text-lg font-semibold">
              {t('Current users')}
            </h2>
            <div className="mt-3 divide-y divide-gray-6">
              {query.data.members.map((member) => (
                <MemberRow
                  key={member.id + ':' + query.data.revision}
                  member={member}
                  disabled={busy || query.isFetching}
                  onChange={(payload) =>
                    void change('/change', { userId: member.id, ...payload })
                  }
                />
              ))}
            </div>
          </section>
          <section className="mt-9 max-w-5xl" aria-labelledby="pending-users">
            <h2 id="pending-users" className="text-lg font-semibold">
              {t('Pending invitations')}
            </h2>
            {query.data.invitations.length ? (
              <div className="mt-3 divide-y divide-gray-6">
                {query.data.invitations.map((invite) => (
                  <div
                    key={invite.id}
                    className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="break-all text-sm font-medium">
                        {invite.email ?? t('Earlier invitation')}
                      </p>
                      <p className="mt-1 text-sm text-gray-11">
                        {roleLabel(invite.role)} ·{' '}
                        {t('Expires {date}', {
                          date: new Date(invite.expiresAt).toLocaleString(),
                        })}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      disabled={busy || query.isFetching}
                      onClick={() =>
                        void change('/revoke', { invitationId: invite.id })
                      }
                    >
                      {t('Revoke invitation')}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-gray-11">
                {t('No pending invitations.')}
              </p>
            )}
          </section>
        </>
      )}
      {notice && (
        <p role="status" className="mt-5 max-w-3xl text-sm leading-6">
          {notice}
        </p>
      )}
      <Button
        variant="ghost"
        className="mt-5"
        disabled={busy || query.isFetching}
        onClick={() => {
          setUrl(null);
          void query.refetch();
        }}
      >
        {t('Refresh users')}
      </Button>
    </main>
  );
}
function MemberRow({
  member,
  disabled,
  onChange,
}: {
  member: z.infer<typeof Member>;
  disabled: boolean;
  onChange: (payload: Record<string, unknown>) => void;
}) {
  const [role, setRole] = useState(member.platformRole);
  return (
    <div className="flex flex-col gap-4 py-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <p className="break-all text-sm font-medium">
          {[member.firstName, member.lastName].filter(Boolean).join(' ') ||
            member.email}
        </p>
        <p className="mt-1 break-all text-sm text-gray-11">{member.email}</p>
        <p className="mt-1 text-sm text-gray-11">
          {member.status === 'ACTIVE' ? t('Active') : t('Inactive')} ·{' '}
          {member.operational
            ? t('Sydekyks operational access')
            : member.admissionSource === 'tenant_admin'
            ? t('Client admin admitted')
            : member.admissionSource === 'operator'
            ? t('Operator admitted')
            : t('Email verified')}
        </p>
      </div>
      {member.protected ? (
        <p className="text-sm text-gray-11">{t('Protected account')}</p>
      ) : member.status !== 'ACTIVE' ? (
        <p className="text-sm text-gray-11">
          {t('Create a new link to restore access.')}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <select
            className={selectStyle}
            aria-label={t('Role for {email}', { email: member.email })}
            value={role}
            disabled={disabled}
            onChange={(event) => setRole(event.target.value as PlatformRole)}
          >
            <RoleOptions />
          </select>
          <Button
            variant="outline"
            disabled={disabled || role === member.platformRole}
            onClick={() => onChange({ role })}
          >
            {t('Save role')}
          </Button>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => onChange({ deactivate: true })}
          >
            {t('Deactivate')}
          </Button>
        </div>
      )}
    </div>
  );
}
