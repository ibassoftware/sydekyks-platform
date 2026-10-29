import { LogSliceRef } from '@activepieces/shared';

import { authenticationSession } from '@/lib/authentication-session';

export const AUTO_PREVIEW_BYTES = 1024 * 1024;
export const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;

let lastScope: string | undefined;
let scopeRevision = 0;
export function outputSessionKey() {
  const scope = `${authenticationSession.getToken() ?? ''}\0${
    authenticationSession.getProjectId() ?? ''
  }`;
  if (scope !== lastScope) {
    lastScope = scope;
    scopeRevision++;
  }
  return String(scopeRevision);
}

export class OutputPreviewTooLarge extends Error {}

export function subscribeOutputSession(listener: () => void) {
  for (const event of ['storage', 'focus', 'pageshow'])
    window.addEventListener(event, listener);
  return () => {
    for (const event of ['storage', 'focus', 'pageshow'])
      window.removeEventListener(event, listener);
  };
}

// Storage slicing keeps the run manifest small. It does not limit what can be
// inspected. Fetch only this file, cap actual streamed bytes, and never forward
// the account credential to a signed external storage URL.
export async function loadSlicedOutput(
  ref: LogSliceRef,
  signal: AbortSignal,
  authenticated: boolean,
): Promise<string> {
  const session = outputSessionKey();
  const assertCurrent = () => {
    if (signal.aborted || session !== outputSessionKey())
      throw new Error('Output session changed');
  };
  assertCurrent();
  const url = new URL(ref.url, window.location.origin);
  if (
    url.protocol !== 'https:' &&
    !(url.origin === window.location.origin && url.protocol === 'http:')
  )
    throw new Error('Unsupported output URL');
  const privatePath =
    url.origin === window.location.origin &&
    url.pathname === `/api/v1/files/${ref.fileId}` &&
    /^[a-zA-Z0-9_-]{21}$/.test(ref.fileId);
  if (authenticated && !privatePath)
    throw new Error('Private output URL required');
  const token = authenticationSession.getToken();
  if (authenticated && !token)
    throw new Error('Current workspace session required');
  const response = await fetch(url.href, {
    signal,
    credentials: 'omit',
    cache: 'no-store',
    redirect: authenticated ? 'error' : 'follow',
    headers: authenticated ? { Authorization: `Bearer ${token}` } : undefined,
  });
  assertCurrent();
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Output unavailable');
  }
  if (Number(response.headers.get('content-length')) > MAX_PREVIEW_BYTES) {
    await response.body?.cancel();
    throw new OutputPreviewTooLarge('Output exceeds preview size');
  }
  if (!response.body) throw new Error('Output unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      assertCurrent();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PREVIEW_BYTES)
        throw new OutputPreviewTooLarge('Output exceeds preview size');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  assertCurrent();
  const text = await new Blob(chunks).text();
  assertCurrent();
  return text;
}

export function structuredPreview(text: string): { value: unknown } | null {
  if (text.length > 128 * 1024) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 2000 || item.depth > 20) return null;
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return { value };
}
