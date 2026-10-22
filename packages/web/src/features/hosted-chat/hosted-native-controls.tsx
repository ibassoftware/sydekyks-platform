import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { Files, Globe } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { useHostedChatPayer } from './hosted-chat-provider';
import { hostedNativeFilesApi } from './hosted-native-files-api';

export function HostedWebSearchControl({ disabled }: { disabled: boolean }) {
  const chat = useHostedChatPayer();
  if (!chat?.options?.nativeFeatures) return null;
  return (
    <Button
      type="button"
      variant={chat.nativeWebSearch ? 'secondary' : 'ghost'}
      size="sm"
      className="h-8 gap-1.5 rounded-full px-2 text-xs"
      aria-label={t('Search web')}
      aria-pressed={chat.nativeWebSearch}
      disabled={
        disabled || !chat.ready || !chat.options.nativeFeatures.webSearch
      }
      onClick={() => chat.setNativeWebSearch(!chat.nativeWebSearch)}
    >
      <Globe className="size-4" aria-hidden="true" />
      {t('Web')}
    </Button>
  );
}

export function HostedNativeFileManager({ disabled }: { disabled: boolean }) {
  const chat = useHostedChatPayer();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const scope = chat?.scope;
  const list = useQuery({
    queryKey: ['native-ai-files', scope?.session.epoch, scope?.projectPointer],
    queryFn: () => hostedNativeFilesApi.list(scope!),
    enabled: !!scope && !!chat?.options?.nativeFeatures && open,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  if (!chat?.options?.nativeFeatures) return null;
  return (
    <div className="border-t border-gray-6 px-3 py-2 text-xs text-gray-11">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 leading-5">
          {chat.payer?.type === 'byok'
            ? t(
                'Your key covers AI and web search. Your provider bills usage separately.',
              )
            : t('Files and search: up to {credits} Credits per message.', {
                credits: chat.options.nativeFeatures.maxTurnCredits,
              })}
        </p>
        <button
          type="button"
          className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          aria-expanded={open}
          aria-controls="hosted-native-files"
          onClick={() => {
            setOpen(!open);
            setError(null);
          }}
        >
          <Files className="size-3.5" aria-hidden="true" />
          {t('My AI files')}
        </button>
      </div>
      {open && (
        <section
          id="hosted-native-files"
          className="mt-3 max-h-48 space-y-3 overflow-y-auto overscroll-contain rounded pb-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 sm:max-h-64"
          aria-label={t('My AI files')}
          tabIndex={0}
        >
          <p className="leading-5">
            {t(
              'Uploads expire after 24 hours. Removing access prevents future AI reads; saved replies remain. Start a new chat after removing a file used in this conversation.',
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
                'No active AI uploads in this project. Attach a file to your next message.',
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
                        date: new Date(file.expiresAt).toLocaleString(),
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
                              'The file ID could not be copied. Allow clipboard access and try again.',
                            ),
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
                            'Removal could not be confirmed. Reload the file list before trying again.',
                          ),
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
      )}
    </div>
  );
}
