import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

type Session = ReturnType<typeof useHostedAuthSession>;
const id = z.string().length(21),
  amount = z.string().regex(/^\d+$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const Identity = z.object({
  userId: id,
  platformId: id,
  identityId: id,
  tokenVersion: z.string().nullable(),
});
const History = z.object({
  id,
  revision: z.number(),
  created: z.string(),
  outcome: z.enum(['verified_usage', 'confirmed_not_sent', 'retain']),
  reason: z.string(),
  evidenceReference: z.string(),
  supplierRequestId: z.string().nullable(),
  operatorIdentityId: id,
  result: z.record(z.string(), z.unknown()),
});
const View = z.object({
  nativeTool: z.enum(['search', 'fetch']).nullable().optional(),
  toolUnitPriceMicroUsd: amount.nullable().optional(),
  identity: Identity,
  callId: id,
  platformId: id,
  projectId: id,
  rootReservationId: id,
  payer: z.enum(['managed', 'byok']),
  state: z.string(),
  revision: z.number().int().nonnegative(),
  stateHash: hash,
  heldCredits: amount,
  heldSupplierMicroUsd: amount,
  accountingVersion: z.string(),
  microUsdPerCredit: amount,
  leaseUntil: z.string(),
  canResolve: z.boolean(),
  blockers: z.array(z.string()),
  history: z.array(History),
  callKey: z.string().optional(),
  attempt: z.number().optional(),
  requestHash: z.string().optional(),
  model: z.string().optional(),
  sentAt: z.string().nullable().optional(),
  budgetDay: z.string().nullable().optional(),
});
const List = z.object({
  identity: Identity,
  platformId: id,
  calls: z.array(View),
  hasMore: z.boolean(),
});
const Preview = z.object({
  view: View,
  preview: z.object({
    expectedRevision: z.number().int(),
    expectedState: hash,
    actualMicroUsd: amount.nullable(),
    actualCredits: amount.nullable(),
    releasedCredits: amount,
    releasedSupplierMicroUsd: amount,
    rootWillSettle: z.boolean(),
    blockers: z.array(z.string()),
  }),
});
const Result = z.object({ view: View, replayed: z.boolean(), auditId: id });
export type ChargeView = z.infer<typeof View>;
export type ChargePreview = z.infer<typeof Preview>;
export type ChargeDraft = {
  platformId: string;
  rootReservationId: string;
  outcome: 'verified_usage' | 'confirmed_not_sent' | 'retain';
  reason: string;
  evidenceReference: string;
  supplierRequestId?: string;
  supplierCreatedAt?: string;
  billable?: boolean;
  usage?: {
    prompt_cache_hit_tokens: number;
    prompt_cache_miss_tokens: number;
    completion_tokens: number;
  };
};
export class ChargeResolutionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export const chargeKey = (
  session: Session,
  platformId: string,
  callId?: string,
) => [
  'hosted-charge-resolution',
  session.epoch,
  session.id,
  session.platformId,
  platformId,
  callId ?? 'list',
];
async function request<T>(
  session: Session,
  platformId: string,
  path: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  body?: unknown,
): Promise<T> {
  assertAuthSession(session);
  if (session.kind !== 'user' || !id.safeParse(platformId).success)
    throw new ChargeResolutionError('SESSION');
  try {
    const raw = await api.sessionScoped<unknown>(
      `/v1/hosting/operator/charge-resolutions${path}`,
      {
        method: body ? 'POST' : 'GET',
        signal,
        ...(body ? { data: body } : { params: { platformId } }),
      },
    );
    assertAuthSession(session);
    const value = schema.parse(raw),
      envelope = value as T & {
        identity?: z.infer<typeof Identity>;
        platformId?: string;
        view?: ChargeView;
        callId?: string;
      };
    const identity = envelope.identity ?? envelope.view?.identity;
    if (
      !identity ||
      identity.userId !== session.id ||
      identity.platformId !== session.platformId ||
      (envelope.view?.platformId ?? envelope.platformId) !== platformId
    )
      throw new ChargeResolutionError('SESSION');
    const expectedCall = path.split('/')[1];
    if (
      expectedCall &&
      (envelope.view?.callId ?? envelope.callId) !== expectedCall
    )
      throw new ChargeResolutionError('SESSION');
    return value;
  } catch (error) {
    assertAuthSession(session);
    if (error instanceof ChargeResolutionError) throw error;
    const code = api.isError(error)
      ? (error.response?.data as { code?: string } | undefined)?.code
      : undefined;
    throw new ChargeResolutionError(
      typeof code === 'string' && code.startsWith('HOSTING_')
        ? code
        : 'UNAVAILABLE',
    );
  }
}
export function useChargeList(
  session: Session,
  platformId: string,
  allowed: boolean,
) {
  return useQuery({
    queryKey: chargeKey(session, platformId),
    queryFn: ({ signal }) => request(session, platformId, '', List, signal),
    enabled: allowed && session.kind === 'user',
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
}
export function useChargeView(
  session: Session,
  platformId: string,
  callId: string,
  allowed: boolean,
) {
  return useQuery({
    queryKey: chargeKey(session, platformId, callId),
    queryFn: ({ signal }) =>
      request(session, platformId, `/${callId}`, View, signal),
    enabled: allowed && session.kind === 'user' && id.safeParse(callId).success,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
}
export const previewCharge = (
  session: Session,
  callId: string,
  draft: ChargeDraft,
  signal: AbortSignal,
) =>
  request(
    session,
    draft.platformId,
    `/${callId}/preview`,
    Preview,
    signal,
    draft,
  );
export const resolveCharge = (
  session: Session,
  callId: string,
  draft: ChargeDraft,
  preview: ChargePreview['preview'],
  requestKey: string,
  signal: AbortSignal,
) =>
  request(session, draft.platformId, `/${callId}/resolve`, Result, signal, {
    ...draft,
    expectedRevision: preview.expectedRevision,
    expectedState: preview.expectedState,
    requestKey,
  });
