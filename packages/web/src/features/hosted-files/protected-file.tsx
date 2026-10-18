import { t } from 'i18next';
import { AnchorHTMLAttributes, useEffect, useRef, useState } from 'react';

import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import {
  assertAuthSession,
  currentAuthSession,
  HostedAuthError,
  useHostedAuthSession,
} from '@/features/hosted-onboarding/auth-session';
import { api } from '@/lib/api';

// Never send credentials to arbitrary URLs supplied by a workflow or AI response.
export function privateFilePath(value: string): string | null {
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    const match = url.pathname.match(/^\/api\/v1\/files\/([a-zA-Z0-9_-]{21})$/);
    return match ? `/v1/files/${match[1]}${url.search}` : null;
  } catch {
    return null;
  }
}

export async function fetchProtectedFile(
  value: string,
  signal?: AbortSignal,
  authenticated = false,
): Promise<Blob> {
  const path = privateFilePath(value);
  if (!path || !authenticated) {
    const response = await fetch(value, { signal });
    if (!response.ok) throw new Error('File unavailable');
    return response.blob();
  }
  const session = currentAuthSession();
  if (session.kind !== 'user') throw new HostedAuthError('session');
  try {
    assertAuthSession(session);
    const blob = await api.sessionScoped<Blob>(path, {
      method: 'GET',
      signal,
      responseType: 'blob',
    });
    assertAuthSession(session);
    return blob;
  } catch {
    assertAuthSession(session);
    throw new HostedAuthError('denied');
  }
}

export function useProtectedFileUrl(value: string) {
  const hosted = useHostedBillingEnabled();
  const session = useHostedAuthSession();
  const protectedFile = hosted && !!privateFilePath(value);
  const [result, setResult] = useState<{
    value: string;
    epoch: string;
    url: string;
  } | null>(null);
  useEffect(() => {
    if (!protectedFile || session.kind !== 'user') return;
    const abort = new AbortController();
    let objectUrl: string | null = null;
    void fetchProtectedFile(value, abort.signal, true)
      .then((blob) => {
        if (abort.signal.aborted) return;
        assertAuthSession(session);
        objectUrl = URL.createObjectURL(blob);
        setResult({ value, epoch: session.epoch, url: objectUrl });
      })
      .catch(() => {
        /* A denied preview never falls back to the bearer URL. */
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [value, protectedFile, session]);
  return protectedFile
    ? result?.value === value && result.epoch === session.epoch
      ? result.url
      : undefined
    : value;
}

export function ProtectedFileLink({
  href = '',
  children,
  download,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const hosted = useHostedBillingEnabled();
  const session = useHostedAuthSession();
  const protectedFile = hosted && !!privateFilePath(href);
  const pending = useRef<AbortController | null>(null);
  const objects = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const retainedObjects = objects.current;
    setBusy(false);
    setFailed(false);
    return () => {
      pending.current?.abort();
      pending.current = null;
      for (const url of retainedObjects) URL.revokeObjectURL(url);
      retainedObjects.clear();
    };
  }, [session]);
  return (
    <>
      <a
        {...props}
        href={protectedFile ? undefined : href}
        role={protectedFile ? 'button' : props.role}
        tabIndex={protectedFile ? 0 : props.tabIndex}
        download={download}
        aria-busy={busy}
        aria-disabled={busy}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          if (protectedFile && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
        onClick={(event) => {
          props.onClick?.(event);
          if (!protectedFile || event.defaultPrevented) return;
          event.preventDefault();
          if (pending.current) return;
          const abort = new AbortController();
          pending.current = abort;
          setBusy(true);
          setFailed(false);
          void fetchProtectedFile(href, abort.signal, true)
            .then((blob) => {
              if (abort.signal.aborted) return;
              assertAuthSession(session);
              const url = URL.createObjectURL(blob);
              objects.current.add(url);
              const link = document.createElement('a');
              link.href = url;
              link.download =
                typeof download === 'string' ? download : 'download';
              link.click();
              setTimeout(() => {
                URL.revokeObjectURL(url);
                objects.current.delete(url);
              }, 1000);
            })
            .catch(() => {
              if (!abort.signal.aborted) setFailed(true);
            })
            .finally(() => {
              if (pending.current === abort) {
                pending.current = null;
                if (!abort.signal.aborted) setBusy(false);
              }
            });
        }}
      >
        {children}
      </a>
      {failed && (
        <span role="alert" className="text-sm text-danger-11">
          {t('File unavailable. Check your workspace access and try again.')}
        </span>
      )}
    </>
  );
}
