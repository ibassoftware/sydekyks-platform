import { useMutation } from '@tanstack/react-query';
import { t } from 'i18next';
import { useState } from 'react';
import { toast } from 'sonner';

import { authenticationApi } from '@/api/authentication-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authenticationSession } from '@/lib/authentication-session';

export function PasswordSettings() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const mutation = useMutation({
    mutationFn: authenticationApi.changePassword,
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success(t('Password changed. Sign in with your new password.'));
      authenticationSession.logOut();
    },
  });
  return (
    <form
      className="max-w-sm space-y-3 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (newPassword === confirmPassword)
          mutation.mutate({ currentPassword, newPassword });
      }}
    >
      <h2 className="text-sm font-semibold">{t('Change password')}</h2>
      <p className="text-sm text-gray-11">
        {t('Changing your password signs you out on all devices.')}
      </p>
      <Label htmlFor="current-password">{t('Current password')}</Label>
      <Input
        id="current-password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={64}
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        disabled={mutation.isPending}
      />
      <Label htmlFor="settings-new-password">{t('New password')}</Label>
      <Input
        id="settings-new-password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        maxLength={64}
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        disabled={mutation.isPending}
      />
      <p className="text-xs text-gray-11">{t('Use 8 to 64 characters.')}</p>
      <Label htmlFor="confirm-password">{t('Confirm new password')}</Label>
      <Input
        id="confirm-password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        maxLength={64}
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        disabled={mutation.isPending}
      />
      {confirmPassword && newPassword !== confirmPassword && (
        <p role="alert" className="text-sm text-danger-11">
          {t('Passwords do not match')}
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="text-sm text-danger-11">
          {t(
            'Password could not be changed. Check your current password and try again. Accounts using single sign-on must change their password with their provider.',
          )}
        </p>
      )}
      <Button
        type="submit"
        loading={mutation.isPending}
        disabled={newPassword !== confirmPassword}
      >
        {t('Change password')}
      </Button>
    </form>
  );
}
