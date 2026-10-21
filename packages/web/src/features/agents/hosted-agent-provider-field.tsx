import { AIProviderName } from '@activepieces/core-utils';
import { AgentConfig } from '@activepieces/shared';
import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { hostedChatApi } from '@/features/hosted-chat/hosted-chat-api';
import { useHostedAuthSession } from '@/features/hosted-onboarding/auth-session';

export function HostedAgentProviderField({
  projectId,
  config,
  onChange,
}: {
  projectId: string;
  config: Pick<AgentConfig, 'provider' | 'providerConfigId'>;
  onChange: (
    config: Pick<
      AgentConfig,
      'provider' | 'providerConfigId' | 'modelName' | 'modelTierId'
    >,
  ) => void;
}) {
  const session = useHostedAuthSession();
  const query = useQuery({
    queryKey: ['hosted-agent-provider-options', session.epoch, projectId],
    queryFn: ({ signal }) =>
      hostedChatApi.options(
        { session, projectPointer: projectId, conversationId: null },
        signal,
      ),
    enabled: session.kind === 'user',
    retry: false,
    gcTime: 0,
  });
  const managed =
    (!config.provider || config.provider === AIProviderName.ACTIVEPIECES) &&
    !config.providerConfigId;
  const selected = managed
    ? 'managed'
    : config.provider === AIProviderName.DEEPSEEK && config.providerConfigId
    ? config.providerConfigId
    : 'unavailable';
  const selectedAvailable =
    selected === 'managed'
      ? query.data?.managedAvailable
      : query.data?.keys.some((key) => key.id === selected);
  return (
    <div className="flex flex-col gap-2">
      <Select
        value={selected}
        disabled={!query.data || query.isFetching || !!query.error}
        onValueChange={(value) =>
          onChange({
            provider:
              value === 'managed'
                ? AIProviderName.ACTIVEPIECES
                : AIProviderName.DEEPSEEK,
            providerConfigId: value === 'managed' ? null : value,
            modelName: value === 'managed' ? 'sydekyks' : 'deepseek-flash',
            modelTierId: null,
          })
        }
      >
        <SelectTrigger aria-label={t('Agent AI provider')}>
          <SelectValue placeholder={t('Choose AI provider')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="managed" disabled={!query.data?.managedAvailable}>
            {t('Sydekyks')}
          </SelectItem>
          {query.data?.keys.map((key) => (
            <SelectItem key={key.id} value={key.id}>
              {t('BYOK · {name}', { name: key.name })}
            </SelectItem>
          ))}
          {selected !== 'managed' && !selectedAvailable && (
            <SelectItem value={selected} disabled>
              {t('Configured AI provider unavailable')}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
      <p className="text-xs leading-5 text-gray-11">
        {selected === 'managed'
          ? t(
              'Sydekyks manages the model. Credits cover the run and its AI usage.',
            )
          : t(
              'Your selected provider bills AI usage separately. Runs use Credits.',
            )}
      </p>
      {query.error && (
        <div role="alert" className="text-sm text-danger-11">
          {t('AI providers could not be loaded.')}{' '}
          <Button
            type="button"
            variant="link"
            onClick={() => void query.refetch()}
          >
            {t('Retry')}
          </Button>
        </div>
      )}
      {query.data && !query.error && !selectedAvailable && (
        <p role="alert" className="text-sm text-danger-11">
          {t(
            'This AI provider is unavailable. Choose an available provider before running the Agent.',
          )}
        </p>
      )}
    </div>
  );
}
