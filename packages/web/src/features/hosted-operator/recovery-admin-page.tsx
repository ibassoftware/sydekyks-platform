import { useRef, useState } from 'react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { assertAuthSession } from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

import { AdminPasswordForm } from './admin-password-form';
import { useHostedOperatorAccess } from './operator-api';
const State = z.object({
  platformId: z.string(),
  userId: z.string(),
  identityId: z.string().nullable(),
  revision: z.number(),
  stateHash: z.string(),
  eligible: z.boolean(),
  pending: z.boolean(),
  expiresAt: z.string().nullable(),
});
export function AccountRecoveryAdminPage() {
  const access = useHostedOperatorAccess();
  return <RecoverySession key={access.session.epoch} access={access} />;
}
function RecoverySession({
  access,
}: {
  access: ReturnType<typeof useHostedOperatorAccess>;
}) {
  const [email, setEmail] = useState(''),
    [reason, setReason] = useState(''),
    [evidence, setEvidence] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [state, setState] = useState<z.infer<typeof State> | null>(null),
    [link, setLink] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const lock = useRef(false),
    generation = useRef(0);
  async function request(path: string, data?: unknown, lookupEmail?: string) {
    assertAuthSession(access.session);
    const raw = await api.sessionScoped<unknown>(
      '/v1/hosting/operator/account-recovery' + path,
      {
        method: data ? 'POST' : 'GET',
        ...(data ? { data } : { params: { email: lookupEmail ?? email } }),
      },
    );
    assertAuthSession(access.session);
    const value = State.parse(raw);
    if (
      value.platformId !== access.session.platformId ||
      value.userId !== access.session.id
    )
      throw Error('Access changed');
    return { value, raw };
  }
  async function find() {
    if (lock.current || !access.allowed) return;
    lock.current = true;
    setBusy(true);
    setLink(null);
    setNotice('');
    const current = ++generation.current;
    try {
      const { value } = await request('');
      if (current === generation.current) setState(value);
    } catch {
      if (current === generation.current) {
        setState(null);
        setNotice(
          'Account recovery could not load. Refresh to check your access.',
        );
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function command(action: 'issue' | 'revoke') {
    if (
      lock.current ||
      !access.allowed ||
      !state?.eligible ||
      !confirmed ||
      reason.trim().length < 10 ||
      evidence.trim().length < 10
    )
      return;
    lock.current = true;
    setBusy(true);
    setLink(null);
    setNotice('');
    const current = ++generation.current;
    try {
      const { value, raw } = await request('/' + action, {
        email: email.trim().toLowerCase(),
        expectedRevision: state.revision,
        expectedState: state.stateHash,
        requestKey: crypto.randomUUID(),
        identityVerificationConfirmed: true,
        verificationReason: reason.trim(),
        verificationEvidence: evidence.trim(),
      });
      if (current === generation.current) {
        const response = z
          .object({ setupUrl: z.string().nullable(), replayed: z.boolean() })
          .parse(raw);
        setState(value);
        setLink(response.setupUrl);
        setConfirmed(false);
        setNotice(
          action === 'issue'
            ? 'Recovery link created. Share it privately with the person whose identity you verified.'
            : 'Pending recovery links revoked.',
        );
      }
    } catch {
      if (current === generation.current) {
        setState(null);
        setConfirmed(false);
        setNotice(
          'The change was not confirmed. Find this account again and review its current state before trying again.',
        );
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (access.isPending)
    return (
      <p role="status" className="p-6">
        Checking account recovery access…
      </p>
    );
  if (!access.allowed)
    return (
      <p role="status" className="p-6">
        Only Sydekyks platform admins can recover ordinary accounts.
      </p>
    );
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold">Account recovery</h1>
        <p className="mt-3 text-sm leading-6 text-gray-11">
          Verify the person through your approved support procedure before
          issuing a link. This resets a password and closes all previous
          sessions. Existing memberships, courses, receipts and Credits are
          preserved.
        </p>
      </header>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <label htmlFor="recovery-email" className="block text-sm font-medium">
          Account email
        </label>
        <Input
          id="recovery-email"
          type="email"
          required
          value={email}
          disabled={busy}
          onChange={(e) => {
            generation.current++;
            setEmail(e.target.value);
            setReason('');
            setEvidence('');
            setState(null);
            setLink(null);
            setConfirmed(false);
            setNotice('');
          }}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={busy || !email.trim()}
        >
          Find account
        </Button>
      </form>
      {state && !state.eligible && (
        <p role="status" className="text-sm leading-6">
          This account is not eligible for web recovery. Global admins, team
          members, trainers and your own account require the privileged-account
          recovery procedure. New accounts use an initial setup link.
        </p>
      )}
      {state?.eligible && (
        <section
          className="space-y-4 border-y border-gray-6 py-5"
          aria-labelledby="verify-person"
        >
          <h2 id="verify-person" className="font-semibold">
            Record identity verification
          </h2>
          <p className="text-sm leading-6 text-gray-11">
            A verified email address in the account is not enough to approve
            this request. Record a support reference and the verification you
            performed. Do not enter passwords, ID scans or supplier keys.
          </p>
          <label className="block text-sm" htmlFor="recovery-reason">
            Recovery reason
          </label>
          <Textarea
            id="recovery-reason"
            maxLength={1000}
            minLength={10}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
          <label className="block text-sm" htmlFor="recovery-evidence">
            Support reference and verification evidence
          </label>
          <Textarea
            id="recovery-evidence"
            maxLength={1000}
            minLength={10}
            value={evidence}
            disabled={busy}
            onChange={(e) => setEvidence(e.target.value)}
          />
          <label className="flex items-start gap-3 text-sm leading-6">
            <input
              className="mt-1 h-4 w-4 shrink-0"
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              I verified the intended recipient through the approved recovery
              procedure and reviewed this exact account.
            </span>
          </label>
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={
                busy ||
                !confirmed ||
                reason.trim().length < 10 ||
                evidence.trim().length < 10
              }
              onClick={() => void command('issue')}
            >
              {state.pending ? 'Replace recovery link' : 'Create recovery link'}
            </Button>
            {state.pending && (
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !confirmed ||
                  reason.trim().length < 10 ||
                  evidence.trim().length < 10
                }
                onClick={() => void command('revoke')}
              >
                Revoke recovery link
              </Button>
            )}
          </div>
          <p className="text-sm text-gray-11">
            Single use · expires within 30 minutes · replacing the link
            invalidates the previous one.
          </p>
        </section>
      )}
      {link && (
        <section className="space-y-3" aria-label="Private recovery link">
          <p className="text-sm leading-6">
            Copy before leaving this page. The original link is not kept in a
            history or account list.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(link).then(
                () => setNotice('Private recovery link copied.'),
                () =>
                  setNotice(
                    'Clipboard access failed. Select and copy the private link below.',
                  ),
              );
            }}
          >
            Copy recovery link
          </Button>
          <Input
            aria-label="Private recovery link"
            type="password"
            autoComplete="off"
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
          />
        </section>
      )}
      <AdminPasswordForm access={access} />
      {notice && (
        <p role="status" className="text-sm leading-6">
          {notice}
        </p>
      )}
    </main>
  );
}
