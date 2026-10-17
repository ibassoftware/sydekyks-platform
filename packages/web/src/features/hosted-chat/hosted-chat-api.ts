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
};
export type HostedChatSubmission = {
  payer: HostedChatPayer;
  projectId: string;
  scope: HostedChatScope;
  assertCurrent: () => void;
  bindConversation: (id: string) => void;
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
  credits: HostedCredits,
  platformId: z.string().length(21),
  userId: z.string().length(21),
  requestedProjectId: z.string().length(21),
  projectId: z.string().length(21),
  conversationId: z.string().length(21).nullable(),
  model: z.object({
    id: z.literal('deepseek-flash'),
    label: z.string().max(80),
  }),
  managedAvailable: z.boolean(),
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
      return 'Choose managed credits or a DeepSeek key before sending.';
    case 'key':
      return 'This DeepSeek key is no longer available. Choose another billing option.';
    case 'project':
      return 'This conversation belongs to a different project. Reopen it or start a new chat.';
    case 'credits':
      return 'Your hosted allowance is unavailable or exhausted. Check your billing before sending again.';
    case 'send':
      return 'The send outcome could not be confirmed. Refresh the conversation before sending again; another send may use another execution.';
    default:
      return 'Could not refresh chat billing. Check your connection and refresh the options.';
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
    if (
      code?.startsWith('HOSTING_') &&
      /CREDITS|ENTITLEMENT|TRIAL|SUSPENDED|BUDGET/.test(code)
    )
      throw new HostedChatError('credits');
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
  if (!payer) throw new HostedChatError('selection');
  if (!options) throw new HostedChatError('unavailable');
  if (
    payer.type === 'managed'
      ? !options.managedAvailable
      : !options.keys.some((key) => key.id === payer.configId)
  )
    throw new HostedChatError(payer.type === 'byok' ? 'key' : 'unavailable');
}
