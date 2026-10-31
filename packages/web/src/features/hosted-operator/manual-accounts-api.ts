import { z } from 'zod';

import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

type Session = ReturnType<typeof useHostedAuthSession>;
const id = z.string().length(21);
export const ManualAccount = z.object({
  identityId: id,
  platformId: id,
  name: z.string(),
  email: z.string(),
  planId: z.enum(['training', 'starter', 'team', 'scale']),
  kind: z.enum(['partner', 'client']),
  package: z.enum(['starter', 'core', 'launch']).nullable().optional(),
  monthlyCreditCap: z.number().int().nonnegative().nullable().optional(),
  termId: id,
  revision: z.number().int().positive(),
  startsAt: z.string(),
  expiresAt: z.string(),
  graceEndsAt: z.string(),
  monthlyCredits: z.number().int().nonnegative(),
  seats: z.number().int().positive(),
  enrollmentId: id.nullable(),
});
export type ManualAccount = z.infer<typeof ManualAccount>;
export type ManualAccountInput = {
  requestKey: string;
  companyName: string;
  fullName: string;
  email: string;
  password: string;
  expiresAt: string;
  monthlyCredits?: number;
  reason: string;
} & (
  | {
      kind: 'partner';
      planId: 'training';
      partner: {
        package: 'starter' | 'core' | 'launch';
        courseId?: string;
        approve: boolean;
      };
    }
  | { kind: 'client'; planId: 'starter' | 'team' | 'scale' }
);
const Response = z.object({
  platformId: id,
  userId: id,
  account: ManualAccount,
  replayed: z.boolean().optional(),
});
export class ManualAccountError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
async function request(
  session: Session,
  path: string,
  method: 'POST' | 'GET',
  data?: unknown,
) {
  if (session.kind !== 'user') throw new ManualAccountError('SESSION_CHANGED');
  assertAuthSession(session);
  try {
    const raw = await api.sessionScoped<unknown>(
      '/v1/hosting/operator/manual-accounts' + path,
      { method, ...(data === undefined ? {} : { data }) },
    );
    assertAuthSession(session);
    const parsed = Response.safeParse(raw);
    if (!parsed.success) throw new ManualAccountError('UNCONFIRMED');
    if (
      parsed.data.platformId !== session.platformId ||
      parsed.data.userId !== session.id
    )
      throw new ManualAccountError('SESSION_CHANGED');
    return parsed.data;
  } catch (error) {
    assertAuthSession(session);
    if (error instanceof ManualAccountError) throw error;
    const code = api.isError(error)
      ? (error.response?.data as { code?: unknown })?.code
      : undefined;
    throw new ManualAccountError(
      typeof code === 'string' && /^HOSTING_[A-Z_]{1,100}$/.test(code)
        ? code
        : 'UNCONFIRMED',
    );
  }
}
export async function createManualAccount(
  session: Session,
  input: ManualAccountInput,
) {
  const result = await request(session, '', 'POST', input);
  if (
    result.account.email.toLowerCase() !== input.email.trim().toLowerCase() ||
    result.account.kind !== input.kind ||
    result.account.planId !== input.planId ||
    (input.kind === 'partner' &&
      input.partner.package === 'starter' &&
      (result.account.package !== 'starter' ||
        result.account.monthlyCreditCap !== 3500 ||
        result.account.monthlyCredits > 3500))
  )
    throw new ManualAccountError('UNCONFIRMED');
  return result;
}
export async function readManualAccount(session: Session, platformId: string) {
  const result = await request(
    session,
    '?platformId=' + encodeURIComponent(platformId),
    'GET',
  );
  if (result.account.platformId !== platformId)
    throw new ManualAccountError('UNCONFIRMED');
  return result;
}
export async function renewManualAccount(
  session: Session,
  platformId: string,
  input: {
    requestKey: string;
    expectedRevision: number;
    expiresAt: string;
    monthlyCredits?: number;
    reason: string;
  },
) {
  const result = await request(
    session,
    '/' + encodeURIComponent(platformId) + '/terms',
    'POST',
    input,
  );
  if (result.account.platformId !== platformId)
    throw new ManualAccountError('UNCONFIRMED');
  return result;
}

const ManualPartnerCourses = z.array(
  z.object({
    id: id,
    ownerPlatformId: z.string().nullable(),
    audience: z.string(),
    certificationMode: z.string(),
    status: z.string(),
    content: z.object({ title: z.string() }),
  }),
);
export async function readManualPartnerCourses(session: Session) {
  assertAuthSession(session);
  const rows = ManualPartnerCourses.parse(
    await api.sessionScoped<unknown>('/v1/lms/operator/courses', {
      method: 'GET',
    }),
  );
  assertAuthSession(session);
  return rows.filter(
    (course) =>
      course.ownerPlatformId === null &&
      course.audience === 'partner' &&
      course.certificationMode === 'partner' &&
      course.status === 'published',
  );
}
export async function enrollManualPartner(
  session: Session,
  platformId: string,
  input: { requestKey: string; expectedRevision: number; courseId: string },
) {
  const result = await request(
    session,
    '/' + encodeURIComponent(platformId) + '/enrollment',
    'POST',
    input,
  );
  if (result.account.platformId !== platformId || !result.account.enrollmentId)
    throw new ManualAccountError('UNCONFIRMED');
  return result;
}
