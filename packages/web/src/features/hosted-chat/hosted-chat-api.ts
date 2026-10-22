import { z } from 'zod';

import { currentAuthSession } from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';
import { authenticationSession } from '@/lib/authentication-session';

export type HostedChatPayer =
  | { type: 'managed' }
  | { type: 'byok'; configId: string };
export type HostedChatScope = {
  session: ReturnType<typeof currentAuthSession>;
  projectPointer: string;
  conversationId: string | null;
  agentId?: string;
  builder?: boolean;
  nativeAgent?: boolean;
};
export type HostedChatSubmission = {
  payer: HostedChatPayer;
  projectId: string;
  scope: HostedChatScope;
  assertCurrent: () => void;
  bindConversation: (id: string) => void;
  nativeWebSearch?: boolean;
};
const creditQuantity = z.string().regex(/^\d+$/);
export const HostedCreditMeter = z.object({
  scale: z.enum(['1', '1000000']),
  amount: creditQuantity,
  consumed: creditQuantity,
  reserved: creditQuantity,
  available: creditQuantity,
  validUntil: z.string().nullable(),
});
export const HostedCredits = z.object({
  execution: HostedCreditMeter,
  ai: HostedCreditMeter,
  previousHeldAi: creditQuantity,
});
export const HostedCustomerCredits = HostedCredits.pick({ execution: true });
export function formatHostedCredits(value: string, scale = '1') {
  const n = BigInt(value),
    d = BigInt(scale),
    fraction = (n % d)
      .toString()
      .padStart(d.toString().length - 1, '0')
      .replace(/0+$/, '');
  return `${(n / d).toLocaleString()}${fraction ? `.${fraction}` : ''}`;
}
export const HostedChatOptions = z.object({
  nativeFeatures: z
    .object({
      files: z.boolean(),
      webSearch: z.boolean(),
      maxTurnCredits: z.number().int().positive(),
      maxFilesPerTurn: z.number().int().positive().max(4),
    })
    .optional(),
  credits: HostedCustomerCredits,
  platformId: z.string().length(21),
  userId: z.string().length(21),
  requestedProjectId: z.string().length(21),
  projectId: z.string().length(21),
  conversationId: z.string().length(21).nullable(),
  model: z.object({
    id: z.literal('sydekyks'),
    label: z.string().max(80),
  }),
  payerLock: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('managed') }),
      z.object({ type: z.literal('byok'), configId: z.string().length(21) }),
    ])
    .optional(),
  managedAvailable: z.boolean(),
  creditPolicy: z
    .object({
      executionCredits: z.literal(1),
      maxRunCredits: creditQuantity,
    })
    .optional(),
  keys: z.array(
    z.object({ id: z.string().length(21), name: z.string().min(1).max(80) }),
  ),
});
export type HostedChatOptions = z.infer<typeof HostedChatOptions>;
export class HostedChatError extends Error {
  constructor(
    public readonly kind:
      | 'session'
      | 'denied'
      | 'unavailable'
      | 'selection'
      | 'key'
      | 'project'
      | 'credits'
      | 'budget'
      | 'limit'
      | 'access'
      | 'context'
      | 'file'
      | 'send',
  ) {
    super(hostedChatErrorText(kind));
    this.name = 'HostedChatError';
  }
}
export function hostedChatErrorText(kind: HostedChatError['kind']) {
  switch (kind) {
    case 'session':
      return 'Your session changed or expired. Sign in again before sending.';
    case 'denied':
      return 'Chat billing is unavailable for this workspace. Check your access or switch workspaces.';
    case 'selection':
      return 'Choose Sydekyks or an available BYOK key before sending.';
    case 'key':
      return 'This BYOK key is no longer available. Choose another AI provider.';
    case 'project':
      return 'This conversation belongs to a different project. Reopen it or start a new chat.';
    case 'credits':
      return 'Not enough Credits are available. Check billing for usage and pending reservations.';
    case 'budget':
      return 'Sydekyks AI is temporarily paused. Contact your workspace administrator or use an available BYOK key.';
    case 'limit':
      return 'This run reached its Credit spending limit. Reduce the work before starting a new run.';
    case 'access':
      return 'Workspace access is paused or expired. Check billing or contact your workspace administrator.';
    case 'context':
      return 'This conversation exceeds the current chat limits. Start a new chat with a shorter message. No Credits were charged for this send.';
    case 'file':
      return 'An attachment was removed, expired or is unavailable. Start a new chat and upload the file again. No Credits were charged for this send.';
    case 'send':
      return 'The send outcome could not be confirmed. Refresh the conversation before sending again; another send may use Credits.';
    default:
      return 'AI options are currently unavailable. Refresh or contact your workspace administrator.';
  }
}
export function assertHostedChatScope(scope: HostedChatScope) {
  if (
    scope.session.kind !== 'user' ||
    currentAuthSession() !== scope.session ||
    authenticationSession.getProjectId() !== scope.projectPointer
  )
    throw new HostedChatError('session');
}
export async function hostedChatRequest<T>(
  scope: HostedChatScope,
  path: string,
  config: Parameters<typeof api.sessionScoped>[1],
  sending = false,
): Promise<T> {
  assertHostedChatScope(scope);
  try {
    const result = await api.sessionScoped<T>(path, config);
    assertHostedChatScope(scope);
    return result;
  } catch (error) {
    assertHostedChatScope(scope);
    if (error instanceof HostedChatError) throw error;
    const status = api.isError(error) ? error.response?.status : undefined;
    const code = api.isError(error)
      ? (error.response?.data as { code?: string })?.code
      : undefined;
    if (status === 410) throw new HostedChatError('file');
    if (code === 'HOSTING_CHAT_CONTEXT_LIMIT')
      throw new HostedChatError('context');
    if (
      status === 401 ||
      code === 'SESSION_EXPIRED' ||
      code === 'INVALID_BEARER_TOKEN' ||
      code === 'HOSTING_SESSION_EXPIRED'
    )
      throw new HostedChatError('session');
    if (
      code === 'HOSTING_BYOK_SCOPE_DENIED' ||
      code === 'HOSTING_EXACT_BYOK_KEY_REQUIRED'
    )
      throw new HostedChatError('key');
    if (code === 'HOSTING_PROJECT_ACCESS_DENIED')
      throw new HostedChatError('project');
    if (code === 'HOSTING_OPERATOR_BUDGET_EXHAUSTED')
      throw new HostedChatError('budget');
    if (
      code === 'HOSTING_RUN_CREDIT_LIMIT' ||
      code === 'HOSTING_NATIVE_CREDIT_LIMIT'
    )
      throw new HostedChatError('limit');
    if (code?.startsWith('HOSTING_') && /CREDITS/.test(code))
      throw new HostedChatError('credits');
    if (
      code?.startsWith('HOSTING_') &&
      /ENTITLEMENT|TRIAL|SUSPENDED/.test(code)
    )
      throw new HostedChatError('access');
    if (status === 403 || status === 404) throw new HostedChatError('denied');
    throw new HostedChatError(sending ? 'send' : 'unavailable');
  }
}
export const hostedChatApi = {
  async options(scope: HostedChatScope, signal: AbortSignal) {
    const raw = await hostedChatRequest<unknown>(
      scope,
      '/v1/ai-providers/chat-options',
      {
        method: 'GET',
        params: {
          projectId: scope.projectPointer,
          ...(scope.agentId ? { agentId: scope.agentId } : {}),
          ...(scope.builder ? { builder: true } : {}),
          ...(scope.conversationId
            ? { conversationId: scope.conversationId }
            : {}),
        },
        signal,
      },
    );
    const result = HostedChatOptions.safeParse(raw);
    if (!result.success) throw new HostedChatError('unavailable');
    const data = result.data;
    if (
      data.platformId !== scope.session.platformId ||
      data.userId !== scope.session.id ||
      data.requestedProjectId !== scope.projectPointer ||
      data.conversationId !== scope.conversationId
    )
      throw new HostedChatError('denied');
    return data;
  },
};
export function assertHostedPayerAvailable(
  payer: HostedChatPayer | null,
  options?: HostedChatOptions,
): asserts payer is HostedChatPayer {
  if (!payer)
    throw new HostedChatError(
      options && !options.managedAvailable && options.keys.length === 0
        ? 'unavailable'
        : 'selection',
    );
  if (!options) throw new HostedChatError('unavailable');
  if (
    payer.type === 'managed'
      ? !options.managedAvailable
      : !options.keys.some((key) => key.id === payer.configId)
  )
    throw new HostedChatError(payer.type === 'byok' ? 'key' : 'unavailable');
}
