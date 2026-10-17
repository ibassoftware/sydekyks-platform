import { t } from 'i18next';
import { ChevronDown, KeyRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { formatHostedCredits } from './hosted-chat-api';
import { useHostedChatPayer } from './hosted-chat-provider';

export function HostedChatSelector({ disabled }: { disabled: boolean }) {
  const chat = useHostedChatPayer();
  if (!chat) return null;
  const keyId = chat.payer?.type === 'byok' ? chat.payer.configId : null;
  const selectedKey = chat.options?.keys.find((key) => key.id === keyId);
  const label =
    chat.payer?.type === 'managed'
      ? t('Managed credits')
      : chat.payer?.type === 'byok'
      ? selectedKey
        ? t('BYOK · {name}', { name: selectedKey.name })
        : t('BYOK key unavailable')
      : t('Choose AI billing');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('AI billing: {label}', { label })}
          disabled={disabled || chat.denied || chat.loading || !chat.options}
          className="h-9 sm:h-7 min-w-0 max-w-56 gap-1.5 rounded-full px-2.5 text-xs text-gray-11 hover:text-gray-12"
        >
          <KeyRound className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        className="w-80 max-w-[calc(100vw-1.5rem)]"
      >
        <DropdownMenuLabel>{t('Pay for DeepSeek Flash')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={
            chat.payer?.type === 'managed'
              ? 'managed'
              : chat.payer?.type === 'byok'
              ? chat.payer.configId
              : ''
          }
          onValueChange={(value) =>
            chat.setPayer(
              value === 'managed'
                ? { type: 'managed' }
                : { type: 'byok', configId: value },
            )
          }
        >
          <DropdownMenuRadioItem
            value="managed"
            disabled={!chat.options?.managedAvailable}
            className="items-start py-3"
          >
            <span className="min-w-0">
              <span className="block font-medium">{t('Managed credits')}</span>
              <span className="block text-xs text-gray-11">
                {t(
                  chat.options?.managedAvailable
                    ? 'Uses execution allowance and managed AI credits.'
                    : 'Managed AI is not configured. Choose an available key.',
                )}
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {chat.options?.keys.map((key) => (
            <DropdownMenuRadioItem
              key={key.id}
              value={key.id}
              className="items-start py-3"
            >
              <span className="min-w-0">
                <span className="block break-words whitespace-normal font-medium">
                  {key.name}
                </span>
                <span className="block text-xs text-gray-11">
                  {t(
                    'BYOK · DeepSeek bills your key. Uses execution allowance.',
                  )}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
          {chat.options?.keys.length === 0 && (
            <p className="px-2 py-3 text-xs text-gray-11">
              {t(
                'No eligible DeepSeek keys in this project. Ask a workspace administrator to add one in AI settings.',
              )}
            </p>
          )}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-2 text-xs text-gray-11">
          {t(
            'Your choice applies to the next message. Each new send or retry may use another execution.',
          )}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function HostedChatBillingNote() {
  const chat = useHostedChatPayer();
  if (!chat) return null;
  const text = chat.loading
    ? t('Refreshing chat billing…')
    : chat.error
    ? t(chat.error.message)
    : chat.payer?.type === 'byok'
    ? t('DeepSeek bills your key. Hosted execution allowance still applies.')
    : t('Uses hosted execution allowance and managed AI credits.');
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-3 py-2 text-xs text-gray-11"
      role="status"
    >
      <div className="min-w-0 flex-1">
        {chat.options && (
          <p className="mb-1 font-medium text-gray-12 tabular-nums">
            {t('{runs} execution credits · {ai} AI credits available', {
              runs: formatHostedCredits(
                chat.options.credits.execution.available,
              ),
              ai: formatHostedCredits(
                chat.options.credits.ai.available,
                chat.options.credits.ai.scale,
              ),
            })}
          </p>
        )}
        <span>{text}</span>
      </div>
      {!chat.denied && !chat.loading && (
        <button
          type="button"
          onClick={chat.refresh}
          className="shrink-0 rounded underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {t('Refresh options')}
        </button>
      )}
    </div>
  );
}
