import { FullLogo } from '@/components/custom/full-logo';
import { ChangePasswordForm } from '@/features/authentication';

const ChangePasswordPage = () => {
  return (
    <div className="mx-auto flex min-h-dvh w-full flex-col items-center justify-center gap-4 px-4 py-8">
      <FullLogo />
      <ChangePasswordForm />
    </div>
  );
};

export { ChangePasswordPage };
