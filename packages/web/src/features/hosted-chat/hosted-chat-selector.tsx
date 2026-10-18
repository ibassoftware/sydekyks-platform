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
      ? t('Sydekyks')
      : chat.payer?.type === 'byok'
      ? selectedKey
        ? t('BYOK · {name}', { name: selectedKey.name })
        : t('BYOK key unavailable')
      : t('Choose AI provider');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('AI provider: {label}', { label })}
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
        <DropdownMenuLabel>{t('AI provider')}</DropdownMenuLabel>
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
              <span className="block font-medium">{t('Sydekyks')}</span>
              {!chat.options?.managedAvailable && (
                <span className="block text-xs text-gray-11">
                  {chat.options?.keys.length
                    ? t(
                        'Currently unavailable. Choose an available key or contact your workspace administrator.',
                      )
                    : t(
                        'Currently unavailable. Contact your workspace administrator.',
                      )}
                </span>
              )}
            </span>
          </DropdownMenuRadioItem>
          {!!chat.options?.keys.length && <DropdownMenuSeparator />}
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
                  {t('BYOK · Your provider bills AI usage separately.')}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function HostedChatBillingNote() {
  const chat = useHostedChatPayer();
  if (!chat) return null;
  const text = chat.loading
    ? t('Refreshing Credits…')
    : chat.error
    ? t(chat.error.message)
    : chat.payer?.type === 'byok'
    ? t('Your provider bills AI usage separately.')
    : '';
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-3 py-2 text-xs text-gray-11"
      role="status"
    >
      <div className="min-w-0 flex-1">
        {chat.options && (
          <p className="mb-1 font-medium text-gray-12 tabular-nums">
            {t('Credits: {available}', {
              available: formatHostedCredits(
                chat.options.credits.execution.available,
              ),
            })}
          </p>
        )}
        {text && <span>{text}</span>}
      </div>
      {!chat.denied && !chat.loading && (
        <button
          type="button"
          onClick={chat.refresh}
          className="shrink-0 rounded underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {t('Refresh')}
        </button>
      )}
    </div>
  );
}
