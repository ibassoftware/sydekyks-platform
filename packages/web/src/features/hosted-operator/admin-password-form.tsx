import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { assertAuthSession } from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

import { useHostedOperatorAccess } from './operator-api';

export function AdminPasswordForm({
  access,
}: {
  access: ReturnType<typeof useHostedOperatorAccess>;
}) {
  const [email, setEmail] = useState(''),
    [currentPassword, setCurrentPassword] = useState(''),
    [newPassword, setNewPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  return (
    <form
      className="space-y-3 border-t border-gray-6 pt-6"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !access.allowed || newPassword !== confirmation) return;
        setBusy(true);
        setNotice('');
        try {
          assertAuthSession(access.session);
          await api.sessionScoped(
            '/v1/hosting/operator/account-recovery/set-password',
            {
              method: 'POST',
              data: { email, currentPassword, newPassword, reason },
            },
          );
          assertAuthSession(access.session);
          setCurrentPassword('');
          setNewPassword('');
          setConfirmation('');
          setNotice(
            'Password changed. All previous sessions have been revoked.',
          );
          // Changing your own password invalidates this operator session too.
        } catch {
          setNotice(
            'Password change was not confirmed. Check the account email and your current password before trying again.',
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="font-semibold">Change any user’s password</h2>
      <p className="text-sm text-gray-11">
        Includes platform admins, team members and trainers with password
        accounts. Enter your own current password to authorize the change. The
        change and reason are recorded.
      </p>
      <Label htmlFor="admin-password-email">Account email</Label>
      <Input
        id="admin-password-email"
        type="email"
        required
        autoComplete="off"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
      />
      <Label htmlFor="admin-current-password">Your current password</Label>
      <Input
        id="admin-current-password"
        type="password"
        required
        maxLength={64}
        autoComplete="current-password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        disabled={busy}
      />
      <Label htmlFor="admin-new-password">New user password</Label>
      <Input
        id="admin-new-password"
        type="password"
        required
        minLength={8}
        maxLength={64}
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        disabled={busy}
      />
      <Label htmlFor="admin-confirm-password">Confirm new user password</Label>
      <Input
        id="admin-confirm-password"
        type="password"
        required
        minLength={8}
        maxLength={64}
        autoComplete="new-password"
        value={confirmation}
        onChange={(e) => setConfirmation(e.target.value)}
        disabled={busy}
      />
      <Label htmlFor="admin-password-reason">Reason for change</Label>
      <Input
        id="admin-password-reason"
        required
        minLength={10}
        maxLength={1000}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={busy}
      />
      <Button
        type="submit"
        loading={busy}
        disabled={!access.allowed || newPassword !== confirmation}
      >
        Change user password
      </Button>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </form>
  );
}
