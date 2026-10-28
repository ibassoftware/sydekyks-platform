import { formatCreditUnits } from '@/lib/hosted-credit-units';
import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { ArrowLeft, Files, Globe, Paperclip } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { FileUploadTrigger } from '@/components/prompt-kit/file-upload';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

import { useHostedChatPayer } from './hosted-chat-provider';
import { hostedNativeFilesApi } from './hosted-native-files-api';

export function HostedWebSearchControl({ disabled }: { disabled: boolean }) {
  const chat = useHostedChatPayer();
  if (!chat?.options?.nativeFeatures) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        'h-9 gap-1.5 rounded-full border px-2.5 text-xs sm:h-8',
        chat.nativeWebSearch
          ? 'border-accent-8 bg-accent-3 text-accent-12 hover:bg-accent-4'
          : 'border-gray-7 text-gray-11 hover:bg-gray-3'
      )}
      aria-label={t('Search web')}
      aria-pressed={chat.nativeWebSearch}
      disabled={
        disabled || !chat.ready || !chat.options.nativeFeatures.webSearch
      }
      onClick={() => chat.setNativeWebSearch(!chat.nativeWebSearch)}
    >
      <Globe className="size-4" aria-hidden="true" />
      <span>{t('Web')}</span>
      <span className="font-semibold">
        {chat.nativeWebSearch ? t('On') : t('Off')}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5',
          chat.nativeWebSearch ? 'bg-accent-9' : 'bg-gray-8'
        )}
      >
        <span
          className={cn(
            'size-3 rounded-full',
            chat.nativeWebSearch ? 'translate-x-3 bg-on-accent' : 'bg-gray-1'
          )}
        />
      </span>
    </Button>
  );
}

export function HostedAttachmentControl({
  disabled,
  uploadDisabled,
}: {
  disabled: boolean;
  uploadDisabled: boolean;
}) {
  const chat = useHostedChatPayer();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'actions' | 'files'>('actions');
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) {
      contentRef.current
        ?.querySelector<HTMLElement>(view === 'files' ? 'h2' : 'button')
        ?.focus();
    }
  }, [open, view]);
  if (!chat?.options?.nativeFeatures?.files) return null;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView('actions');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('Attachments')}
          className="size-9 rounded-full text-gray-11 sm:size-7"
        >
          <Paperclip className="size-4" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        side="top"
        onClick={(event) => event.stopPropagation()}
        className="max-h-[min(28rem,calc(100dvh-8rem))] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain p-3"
      >
        {view === 'actions' ? (
          <div className="space-y-1">
            <FileUploadTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                disabled={disabled || uploadDisabled}
                className="w-full justify-start gap-2"
                onClick={() => setOpen(false)}
              >
                <Paperclip className="size-4" aria-hidden="true" />
                {t('Attach files')}
              </Button>
            </FileUploadTrigger>
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start gap-2"
              onClick={() => setView('files')}
            >
              <Files className="size-4" aria-hidden="true" />
              {t('Manage uploaded files')}
            </Button>
            <p className="border-t border-gray-6 px-3 pt-3 text-xs leading-5 text-gray-11">
              {chat.payer?.type === 'byok'
                ? t('Your provider bills AI and web search separately.')
                : t('Files and search: up to {credits} Credits per message.', {
                    credits: formatCreditUnits(
                      chat.options.nativeFeatures.maxTurnCredits
                    ),
                  })}
            </p>
          </div>
        ) : (
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mb-2 gap-1.5"
              onClick={() => setView('actions')}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              {t('Attachments')}
            </Button>
            <HostedNativeFileManager disabled={disabled} />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function HostedNativeFileManager({ disabled }: { disabled: boolean }) {
  const chat = useHostedChatPayer();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const scope = chat?.scope;
  const list = useQuery({
    queryKey: ['native-ai-files', scope?.session.epoch, scope?.projectPointer],
    queryFn: () => hostedNativeFilesApi.list(scope!),
    enabled: !!scope && !!chat?.options?.nativeFeatures,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  if (!chat?.options?.nativeFeatures) return null;
  return (
    <div className="text-xs text-gray-11">
      <h2
        tabIndex={-1}
        className="mb-2 rounded text-sm font-semibold text-gray-12 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {t('Manage uploaded files')}
      </h2>
      <section className="space-y-3 pb-1" aria-label={t('Uploaded files')}>
        <p className="leading-5">
          {t(
            'Files expire after 24 hours. Removing access stops future reads; saved replies remain. Start a new chat if it used a removed file.'
          )}
        </p>
        {list.isPending ? (
          <p role="status">{t('Loading files…')}</p>
        ) : list.isError ? (
          <div role="alert" className="space-y-2">
            <p>{t('The file list could not be loaded.')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void list.refetch()}
            >
              {t('Reload files')}
            </Button>
          </div>
        ) : !list.data?.length ? (
          <p>
            {t(
              'No active AI uploads in this project. Attach a file to your next message.'
            )}
          </p>
        ) : (
          <ul className="divide-y divide-gray-6">
            {list.data.map((file) => (
              <li
                key={file.id}
                className="flex items-start justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium text-gray-12">
                    {file.name}
                  </p>
                  <p>
                    {t('Expires {date}', {
                      date: new Date(file.expiresAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                    })}
                  </p>
                  <button
                    type="button"
                    className="mt-1 min-h-8 rounded underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    aria-label={t('Copy private file ID for {name}', {
                      name: file.name,
                    })}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(file.id);
                        setCopied(file.id);
                        setError(null);
                      } catch {
                        setError(
                          t(
                            'The file ID could not be copied. Allow clipboard access and try again.'
                          )
                        );
                      }
                    }}
                  >
                    {copied === file.id
                      ? t('File ID copied')
                      : t('Copy file ID for a workflow')}
                  </button>
                </div>
                <button
                  type="button"
                  className="min-h-8 shrink-0 rounded px-1 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
                  disabled={disabled || busy !== null}
                  aria-label={t('Remove access to {name}', {
                    name: file.name,
                  })}
                  onClick={async () => {
                    setBusy(file.id);
                    setError(null);
                    try {
                      await hostedNativeFilesApi.remove(scope!, file.id);
                      await list.refetch();
                    } catch {
                      setError(
                        t(
                          'Removal could not be confirmed. Reload the file list before trying again.'
                        )
                      );
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === file.id ? t('Removing…') : t('Remove access')}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </div>
  );
}
