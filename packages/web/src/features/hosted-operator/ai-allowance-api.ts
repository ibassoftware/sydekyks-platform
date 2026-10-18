import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

import { AiSettingsError } from './ai-settings-api';

type Session = ReturnType<typeof useHostedAuthSession>;
const creditAmount = z.number().int().min(0).max(1_000_000);
const quantity = z.string().regex(/^\d+$/).max(40);
const Allowance = z.object({
  platformId: z.string().length(21),
  userId: z.string().length(21),
  scopePlatformId: z.string().length(21),
  revision: z.number().int().nonnegative(),
  planId: z.string(),
  overrideMonthlyCredits: creditAmount.nullable(),
  defaultMonthlyCredits: creditAmount,
  effectiveMonthlyCredits: creditAmount,
  appliesToCurrentPeriod: z.boolean(),
  period: z
    .object({
      validFrom: z.iso.datetime(),
      validUntil: z.iso.datetime(),
      amountMicroUsd: quantity,
      consumedMicroUsd: quantity,
      reservedMicroUsd: quantity,
      availableMicroUsd: quantity,
    })
    .nullable(),
});
export type AiAllowance = z.infer<typeof Allowance>;
export const aiAllowanceKey = (session: Session, platformId: string) => [
  'hosted-ai-allowance',
  session.epoch,
  session.id,
  session.platformId,
  platformId,
];
async function request(
  session: Session,
  platformId: string,
  signal: AbortSignal,
  body?: {
    expectedRevision: number;
    monthlyCredits: number | null;
    reason?: string;
  },
): Promise<AiAllowance> {
  assertAuthSession(session);
  if (
    session.kind !== 'user' ||
    !z.string().length(21).safeParse(platformId).success
  )
    throw new AiSettingsError('session');
  try {
    const raw = await api.sessionScoped<unknown>(
      '/v1/hosting/operator/ai-allowance',
      {
        method: body ? 'POST' : 'GET',
        signal,
        ...(body
          ? { data: { platformId, ...body, requestKey: crypto.randomUUID() } }
          : { params: { platformId } }),
      },
    );
    assertAuthSession(session);
    const parsed = Allowance.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.userId !== session.id ||
      parsed.data.platformId !== session.platformId ||
      parsed.data.scopePlatformId !== platformId
    )
      throw new AiSettingsError('unavailable');
    return parsed.data;
  } catch (error) {
    assertAuthSession(session);
    if (error instanceof AiSettingsError) throw error;
    const status = api.isError(error) ? error.response?.status : undefined;
    throw new AiSettingsError(
      status === 409
        ? 'conflict'
        : status === 401 || status === 403 || status === 404
        ? 'denied'
        : 'unavailable',
    );
  }
}
export function useAiAllowance(
  session: Session,
  platformId: string,
  allowed: boolean,
) {
  return useQuery({
    queryKey: aiAllowanceKey(session, platformId),
    queryFn: ({ signal }) => request(session, platformId, signal),
    enabled: allowed && session.kind === 'user',
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
}
export const saveAiAllowance = (
  session: Session,
  platformId: string,
  expectedRevision: number,
  monthlyCredits: number | null,
  reason: string | undefined,
  signal: AbortSignal,
) =>
  request(session, platformId, signal, {
    expectedRevision,
    monthlyCredits,
    ...(reason ? { reason } : {}),
  });
