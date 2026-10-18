import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import {
  assertAuthSession,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

type Session = ReturnType<typeof useHostedAuthSession>;
const model = z.enum(['deepseek-flash', 'deepseek-v4-pro']);
const rate = z.object({
  cacheHit: z.number().int().nonnegative().max(1e9),
  cacheMiss: z.number().int().nonnegative().max(1e9),
  output: z.number().int().nonnegative().max(1e9),
});
const rates = z.object({ peak: rate, offPeak: rate, version: z.string() });
const Settings = z.object({
  platformId: z.string().length(21),
  userId: z.string().length(21),
  scopePlatformId: z.string().length(21).nullable(),
  revision: z.number().int().nonnegative(),
  globalRevision: z.number().int().nonnegative(),
  mode: z.enum(['set', 'inherit', 'disabled']),
  model: model.nullable(),
  credential: z.object({
    configured: z.boolean(),
    scope: z.enum(['global', 'client', 'none']),
    version: z.string().nullable(),
  }),
  effective: z.object({
    model: model.nullable(),
    managedAvailable: z.boolean(),
    reason: z.string().nullable(),
  }),
  pricing: z.object({
    status: z.enum([
      'unconfigured',
      'checking',
      'ready',
      'needs_approval',
      'mismatch',
      'error',
      'expired',
    ]),
    revision: z.number().int().nonnegative(),
    observationId: z.string().nullable(),
    termsHash: z.string().nullable(),
    observedAt: z.string().nullable(),
    sourceValidUntil: z.string().nullable(),
    sourceUrl: z
      .url()
      .refine((value) => value.startsWith('https://api-docs.deepseek.com/')),
    calendar: z.object({
      version: z.string(),
      from: z.string(),
      until: z.string(),
      source: z.string(),
      schedule: z.string(),
    }),
    terms: z
      .object({
        models: z.object({ 'deepseek-flash': rates, 'deepseek-v4-pro': rates }),
      })
      .nullable(),
    approval: z
      .object({ id: z.string(), validUntil: z.string(), termsHash: z.string() })
      .nullable(),
  }),
});
export type AiSettings = z.infer<typeof Settings>;
export type ManagedModel = z.infer<typeof model>;
export type SaveAiSettings = {
  platformId?: string;
  expectedRevision: number;
  expectedGlobalRevision: number;
  requestKey: string;
  mode: 'set' | 'inherit' | 'disabled';
  model: 'inherit' | ManagedModel;
  credentialAction: 'keep' | 'replace' | 'inherit';
  apiKey?: string;
};
export class AiSettingsError extends Error {
  constructor(
    public readonly kind: 'denied' | 'conflict' | 'session' | 'unavailable',
  ) {
    super(`Managed AI settings ${kind}`);
  }
}
const base = '/v1/hosting/operator/ai-pricing';
async function request(
  session: Session,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  signal?: AbortSignal,
  scopePlatformId?: string,
): Promise<AiSettings> {
  assertAuthSession(session);
  if (session.kind !== 'user') throw new AiSettingsError('session');
  try {
    const raw = await api.sessionScoped<unknown>(`${base}${path}`, {
      method,
      signal,
      ...(body ? { data: body } : {}),
      ...(method === 'GET' && scopePlatformId
        ? { params: { platformId: scopePlatformId } }
        : {}),
    });
    assertAuthSession(session);
    const parsed = Settings.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.userId !== session.id ||
      parsed.data.platformId !== session.platformId ||
      parsed.data.scopePlatformId !== (scopePlatformId ?? null)
    )
      throw new AiSettingsError('unavailable');
    return parsed.data;
  } catch (error) {
    assertAuthSession(session);
    if (error instanceof AiSettingsError) throw error;
    // Never retain Axios configs: a failed write can contain the submitted key.
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
export function useAiSettings(
  session: Session,
  allowed: boolean,
  platformId?: string,
) {
  return useQuery({
    queryKey: [
      'hosted-ai-settings',
      session.epoch,
      session.id,
      session.platformId,
      platformId ?? 'global',
    ],
    queryFn: ({ signal }) =>
      request(session, '', 'GET', undefined, signal, platformId),
    enabled: allowed,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
}
// Direct writes deliberately avoid React Query mutation variables/cache for secrets.
export const saveAiSettings = (
  session: Session,
  body: SaveAiSettings,
  signal: AbortSignal,
) => request(session, '/settings', 'POST', body, signal, body.platformId);
export const observeAiPricing = (session: Session, signal: AbortSignal) =>
  request(session, '/observe', 'POST', {}, signal);
export const approveAiPricing = (
  session: Session,
  state: AiSettings,
  validUntil: string,
  signal: AbortSignal,
) =>
  request(
    session,
    '/approve',
    'POST',
    {
      expectedRevision: state.pricing.revision,
      observationId: state.pricing.observationId,
      termsHash: state.pricing.termsHash,
      requestKey: crypto.randomUUID(),
      validUntil,
      calendarVersion: state.pricing.calendar.version,
    },
    signal,
  );
