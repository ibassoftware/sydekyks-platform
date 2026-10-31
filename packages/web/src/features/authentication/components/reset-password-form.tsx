import { CreateOtpRequestBody, OtpType } from '@activepieces/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { t } from 'i18next';
import { useState } from 'react';
import { SubmitHandler, useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { z } from 'zod';

import { authenticationApi } from '@/api/authentication-api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Form, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckEmailNote } from '@/features/authentication/components/check-email-note';
import { HttpError } from '@/lib/api';

const FormSchema = z.object({
  email: z.email(t('Please enter a valid email')),
  type: CreateOtpRequestBody.shape.type,
});

type FormSchema = z.infer<typeof FormSchema>;

const ResetPasswordForm = () => {
  const [isSent, setIsSent] = useState<boolean>(false);
  const form = useForm<FormSchema>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      type: OtpType.PASSWORD_RESET,
    },
  });

  const { mutate, isPending, isError } = useMutation<
    void,
    HttpError,
    CreateOtpRequestBody
  >({
    mutationFn: authenticationApi.sendOtpEmail,
    onSuccess: () => setIsSent(true),
  });

  const onSubmit: SubmitHandler<CreateOtpRequestBody> = (data) => {
    mutate(data);
  };

  return (
    <Card className="w-full max-w-md rounded-md">
      <CardHeader>
        <CardTitle className="text-2xl">
          {isSent ? t('Check Your Inbox') : t('Reset Password')}
        </CardTitle>
        <CardDescription>
          {isSent ? (
            <CheckEmailNote
              email={form.getValues().email.trim().toLocaleLowerCase()}
              type={OtpType.PASSWORD_RESET}
            />
          ) : (
            <span>
              {t(
                `If the user exists we'll send you an email with a link to reset your password.`,
              )}
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!isSent && (
          <Form {...form}>
            <form className="grid" onSubmit={form.handleSubmit(onSubmit)}>
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem className="w-full grid space-y-2">
                    <Label htmlFor="email">{t('Email')}</Label>
                    <Input
                      {...field}
                      id="email"
                      type="email"
                      autoComplete="email"
                      placeholder={'email@example.com'}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              {isError && (
                <p role="alert" className="mt-3 text-sm text-danger-11">
                  {t(
                    'Could not request a reset link. Try again shortly or contact your administrator.',
                  )}
                </p>
              )}
              <Button className="w-full mt-4" loading={isPending} type="submit">
                {t('Send Password Reset Link')}
              </Button>
            </form>
          </Form>
        )}
        <div className="mt-4 text-center text-sm">
          <Link to="/sign-in" className="text-gray-11">
            {t('Back to sign in')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
};

ResetPasswordForm.displayName = 'ResetPassword';

export { ResetPasswordForm };
