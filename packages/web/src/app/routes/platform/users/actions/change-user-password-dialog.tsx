import { useMutation } from '@tanstack/react-query';
import { t } from 'i18next';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';

export function ChangeUserPasswordDialog({
  userId,
  email,
  open,
  onClose,
}: {
  userId: string;
  email: string;
  open: boolean;
  onClose: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState(''),
    [newPassword, setNewPassword] = useState(''),
    [confirmation, setConfirmation] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/v1/users/${userId}/password`, {
        currentPassword,
        newPassword,
      }),
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      toast.success(
        t('Password changed. Previous sessions have been revoked.'),
      );
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={() => {
        if (!mutation.isPending) {
          setCurrentPassword('');
          setNewPassword('');
          setConfirmation('');
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Change user password')}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (newPassword === confirmation) mutation.mutate();
          }}
        >
          <p className="break-all text-sm">{email}</p>
          <Label htmlFor="user-admin-current-password">
            {t('Your current password')}
          </Label>
          <Input
            id="user-admin-current-password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={64}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={mutation.isPending}
          />
          <Label htmlFor="user-new-password">{t('New user password')}</Label>
          <Input
            id="user-new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={64}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={mutation.isPending}
          />
          <Label htmlFor="user-confirm-password">
            {t('Confirm new user password')}
          </Label>
          <Input
            id="user-confirm-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={64}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            disabled={mutation.isPending}
          />
          {mutation.isError && (
            <p role="alert" className="text-sm text-danger-11">
              {t(
                'Password could not be changed. Check your current password and permissions. Single sign-on and accounts shared across platforms require their identity provider or operator.',
              )}
            </p>
          )}
          <Button
            type="submit"
            loading={mutation.isPending}
            disabled={newPassword !== confirmation}
          >
            {t('Change user password')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
