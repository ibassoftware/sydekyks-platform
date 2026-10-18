import { z } from 'zod';

import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

type Session = ReturnType<typeof useHostedAuthSession>;
const id = z.string().length(21);
export const PartnerCandidate = z.object({
  identityId: id,
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  verified: z.boolean(),
  verificationMethod: z.enum(['operator', 'email', 'pending']),
  emailOwnershipVerified: z.boolean(),
  role: z.enum(['partner', 'team']).nullable(),
  active: z.boolean(),
  revision: z.number().int().nonnegative(),
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  editable: z.boolean(),
  signInAvailable: z.boolean(),
  workspaces: z.array(z.object({ platformId: id, name: z.string() })),
  assignments: z.array(
    z.object({ platformId: id, name: z.string(), active: z.boolean() }),
  ),
});
export type PartnerCandidate = z.infer<typeof PartnerCandidate>;
const CandidateResponse = z.object({
  platformId: id,
  userId: id,
  candidate: PartnerCandidate.nullable(),
});
const Partners = z.object({
  platformId: id,
  userId: id,
  partners: z.array(PartnerCandidate),
  next: id.nullable(),
});
export class PartnerAdminError extends Error {
  constructor(
    public readonly kind: 'session' | 'denied' | 'conflict' | 'unavailable',
    public readonly code?: string,
  ) {
    super(`Partner administration ${kind}`);
  }
}
async function request<T extends { platformId: string; userId: string }>(
  session: Session,
  path: string,
  schema: z.ZodType<T>,
  options: {
    method?: 'GET' | 'POST';
    data?: unknown;
    params?: unknown;
    signal?: AbortSignal;
  } = {},
) {
  if (session.kind !== 'user') throw new PartnerAdminError('session');
  assertAuthSession(session);
  try {
    const raw = await api.sessionScoped<unknown>(
      '/v1/hosting/operator/partners' + path,
      options,
    );
    assertAuthSession(session);
    const result = schema.safeParse(raw);
    if (!result.success) throw new PartnerAdminError('unavailable');
    if (
      result.data.platformId !== session.platformId ||
      result.data.userId !== session.id
    )
      throw new PartnerAdminError('denied');
    return result.data;
  } catch (error) {
    assertAuthSession(session);
    if (error instanceof PartnerAdminError) throw error;
    const status = api.isError(error) ? error.response?.status : undefined;
    const rawCode = api.isError(error)
      ? (error.response?.data as { code?: unknown })?.code
      : undefined;
    const code =
      typeof rawCode === 'string' && /^HOSTING_[A-Z_]{1,80}$/.test(rawCode)
        ? rawCode
        : undefined;
    throw new PartnerAdminError(
      status === 409
        ? 'conflict'
        : status === 401 || status === 403
        ? 'denied'
        : 'unavailable',
      code,
    );
  }
}
export const lookupPartner = (
  session: Session,
  email: string,
  signal?: AbortSignal,
) =>
  request(session, '/lookup', CandidateResponse, { params: { email }, signal });
export const partnersQuery = (
  session: Session,
  after: string | null,
  allowed: boolean,
) => ({
  queryKey: [
    'hosted-partners',
    session.epoch,
    session.platformId,
    session.id,
    after,
  ],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    request(session, '', Partners, {
      params: after ? { after } : undefined,
      signal,
    }),
  enabled: allowed,
  retry: false as const,
  gcTime: 0,
  staleTime: 0,
});
const precondition = (candidate: PartnerCandidate) => ({
  expectedRevision: candidate.revision,
  expectedState: candidate.stateHash,
  requestKey: crypto.randomUUID(),
});
export const decidePartner = (
  session: Session,
  candidate: PartnerCandidate,
  active: boolean,
) =>
  request(
    session,
    '/' + candidate.identityId + '/decision',
    CandidateResponse,
    { method: 'POST', data: { ...precondition(candidate), active } },
  );
export const assignPartner = (
  session: Session,
  candidate: PartnerCandidate,
  platformId: string,
  assigned: boolean,
) =>
  request(
    session,
    '/' + candidate.identityId + '/assignments',
    CandidateResponse,
    {
      method: 'POST',
      data: { ...precondition(candidate), platformId, assigned },
    },
  );
