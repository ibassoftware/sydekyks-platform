import { AuthenticationResponse } from '@activepieces/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

type Session = ReturnType<typeof useHostedAuthSession>;
const id = z.string().length(21);
const scoped = { platformId: id, userId: id };
const fence = {
  revision: z.number().int().nonnegative(),
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
};
export const Trainer = z.object({
  identityId: id,
  email: z.string(),
  name: z.string(),
  verified: z.boolean(),
  active: z.boolean(),
  ...fence,
  assignments: z.array(
    z.object({
      id,
      kind: z.enum(['partner', 'client', 'recipient']),
      targetId: id,
      name: z.string(),
      active: z.boolean(),
      revision: z.number(),
    }),
  ),
});
export type Trainer = z.infer<typeof Trainer>;
const List = z.object({ ...scoped, trainers: z.array(Trainer) });
const Decision = z.object({ ...scoped, trainer: Trainer });
export const Portfolio = z.object({
  ...scoped,
  ...fence,
  partners: z.array(
    z.object({
      identityId: id,
      email: z.string(),
      firstName: z.string(),
      lastName: z.string(),
    }),
  ),
  clients: z.array(z.object({ platformId: id, name: z.string() })),
  pending: z.array(
    z.object({
      assignmentId: id,
      email: z.string(),
      kind: z.enum(['partner', 'client']),
      expiresAt: z.string(),
    }),
  ),
  setupUrl: z.string().url().nullable().optional(),
});
export type Portfolio = z.infer<typeof Portfolio>;
export async function trainerRequest<T>(
  session: Session,
  path: string,
  schema: z.ZodType<T>,
  data?: unknown,
  signal?: AbortSignal,
  params?: unknown,
): Promise<T> {
  if (session.kind !== 'user') throw new Error('Sign in again to continue.');
  assertAuthSession(session);
  try {
    const raw = await api.sessionScoped<unknown>('/v1/hosting' + path, {
      method: data === undefined ? 'GET' : 'POST',
      data,
      signal,
      params,
    });
    assertAuthSession(session);
    const value = schema.parse(raw);
    const result = value as T & { platformId: string; userId: string };
    if (
      result.platformId !== session.platformId ||
      result.userId !== session.id
    )
      throw new Error();
    return value;
  } catch {
    assertAuthSession(session);
    // Never retain Axios configs, bearer credentials or setup response bodies.
    throw new Error(
      'This action could not be confirmed. Refresh the page and check your current access before trying again.',
    );
  }
}
export const trainerPrecondition = (value: {
  revision: number;
  stateHash: string;
}) => ({
  expectedRevision: value.revision,
  expectedState: value.stateHash,
  requestKey: crypto.randomUUID(),
});
export const listTrainers = (
  s: Session,
  email?: string,
  signal?: AbortSignal,
) =>
  trainerRequest(
    s,
    '/operator/trainers',
    List,
    undefined,
    signal,
    email ? { email } : undefined,
  );
export const decideTrainer = (s: Session, value: Trainer, active: boolean) =>
  trainerRequest(s, '/operator/trainers/decision', Decision, {
    ...trainerPrecondition(value),
    trainerIdentityId: value.identityId,
    active,
  });
export const assignTrainer = (
  s: Session,
  value: Trainer,
  input: {
    assignmentId?: string;
    kind?: 'partner' | 'client';
    targetId?: string;
    active: boolean;
  },
) =>
  trainerRequest(s, '/operator/trainers/assignment', Decision, {
    ...trainerPrecondition(value),
    trainerIdentityId: value.identityId,
    ...input,
  });
export function usePlatformTrainerAccess() {
  const session = useHostedAuthSession(),
    hosted = useHostedBillingEnabled();
  const query = useQuery({
    queryKey: ['hosted-trainer-access', session.epoch],
    queryFn: ({ signal }) =>
      trainerRequest(
        session,
        '/trainer/access',
        z.object({ ...scoped, allowed: z.boolean() }),
        undefined,
        signal,
      ),
    enabled: hosted && session.kind === 'user',
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  return {
    ...query,
    session,
    hosted,
    allowed:
      hosted &&
      session.kind === 'user' &&
      !query.error &&
      query.data?.allowed === true,
  };
}
export async function enterTrainerClient(s: Session, platformId: string) {
  assertAuthSession(s);
  try {
    const raw = await api.sessionScoped<unknown>(
      '/v1/hosting/trainer/clients/' +
        encodeURIComponent(platformId) +
        '/enter',
      { method: 'POST' },
    );
    assertAuthSession(s);
    const parsed = AuthenticationResponse.parse(raw);
    if (parsed.platformId !== platformId) throw new Error();
    return parsed;
  } catch {
    assertAuthSession(s);
    throw new Error(
      'The workspace could not be opened. Refresh your portfolio to check your assignment.',
    );
  }
}
