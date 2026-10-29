// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({
  token: 'fixture-user-token',
  project: 'project-one',
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: {
    getToken: () => session.token,
    getProjectId: () => session.project,
  },
}));
import {
  loadSlicedOutput,
  MAX_PREVIEW_BYTES,
  OutputPreviewTooLarge,
  structuredPreview,
} from '@/app/builder/run-details/sliced-output-loader';
const ref = {
  fileId: '123456789012345678901',
  size: 42905,
  url: '/api/v1/files/123456789012345678901?token=fixture-read-token',
};
const fetcher = vi.fn();
const encoder = new TextEncoder();
function response(chunks: Uint8Array[], contentLength?: number) {
  const cancel = vi.fn().mockResolvedValue(undefined);
  let index = 0;
  return {
    cancel,
    response: {
      ok: true,
      headers: new Headers(
        contentLength ? { 'content-length': String(contentLength) } : {}
      ),
      body: {
        cancel,
        getReader: () => ({
          read: async () =>
            index < chunks.length
              ? { done: false, value: chunks[index++] }
              : { done: true },
          cancel,
          releaseLock: vi.fn(),
        }),
      },
    },
  };
}
beforeEach(() => {
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('Blob', NodeBlob);
  fetcher.mockReset();
  session.token = 'fixture-user-token';
  session.project = 'project-one';
});
afterEach(() => vi.unstubAllGlobals());

describe('saved output transport', () => {
  it('loads the complete 41.9 KB output with the current hosted credential', async () => {
    const text = JSON.stringify({
      result: 'x'.repeat(42900),
      unicode: '東京 🌏',
    });
    const bytes = encoder.encode(text);
    const stream = response([
      bytes.slice(0, bytes.length - 3),
      bytes.slice(bytes.length - 3),
    ]);
    fetcher.mockResolvedValue(stream.response);
    expect(
      await loadSlicedOutput(ref, new AbortController().signal, true)
    ).toBe(text);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/files/'),
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        headers: { Authorization: 'Bearer fixture-user-token' },
      })
    );
  });
  it('refuses hosted credentials for external or mismatched file URLs', async () => {
    for (const url of [
      'https://storage.example/output.json',
      '/api/v1/users/me',
      '/api/v1/files/987654321098765432109',
    ])
      await expect(
        loadSlicedOutput({ ...ref, url }, new AbortController().signal, true)
      ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses signed self-hosted storage URLs without account credentials', async () => {
    fetcher.mockResolvedValue(response([encoder.encode('false')]).response);
    expect(
      await loadSlicedOutput(
        { ...ref, url: 'https://storage.example/output.json' },
        new AbortController().signal,
        false
      )
    ).toBe('false');
    expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
    expect(fetcher.mock.calls[0][1].credentials).toBe('omit');
  });
  it('cancels an oversized declared response before reading', async () => {
    const stream = response([], MAX_PREVIEW_BYTES + 1);
    fetcher.mockResolvedValue(stream.response);
    await expect(
      loadSlicedOutput(ref, new AbortController().signal, true)
    ).rejects.toBeInstanceOf(OutputPreviewTooLarge);
    expect(stream.cancel).toHaveBeenCalled();
  });
  it('caps actual bytes even if the stored or HTTP size is wrong', async () => {
    const stream = response([
      new Uint8Array(MAX_PREVIEW_BYTES),
      new Uint8Array(1),
    ]);
    fetcher.mockResolvedValue(stream.response);
    await expect(
      loadSlicedOutput(ref, new AbortController().signal, true)
    ).rejects.toBeInstanceOf(OutputPreviewTooLarge);
    expect(stream.cancel).toHaveBeenCalled();
  });
  it.each(['token', 'project'])(
    'discards a response after the %s changes',
    async (field) => {
      fetcher.mockImplementation(async () => {
        session[field as 'token' | 'project'] = 'changed';
        return response([encoder.encode('private data')]).response;
      });
      await expect(
        loadSlicedOutput(ref, new AbortController().signal, true)
      ).rejects.toThrow('session changed');
    }
  );
  it('does not start an aborted request', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(loadSlicedOutput(ref, abort.signal, true)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves null, false and strings and bounds structured rendering complexity', () => {
    expect(structuredPreview('null')).toEqual({ value: null });
    expect(structuredPreview('false')).toEqual({ value: false });
    expect(structuredPreview('"hello"')).toEqual({ value: 'hello' });
    expect(structuredPreview('{bad json')).toBeNull();
    expect(structuredPreview(JSON.stringify(Array(3000).fill(1)))).toBeNull();
    expect(structuredPreview('['.repeat(25) + '0' + ']'.repeat(25))).toBeNull();
  });
});
