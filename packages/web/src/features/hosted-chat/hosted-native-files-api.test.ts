/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ current: true, api: vi.fn() }));
vi.mock('./hosted-chat-api', () => ({
  assertHostedChatScope: () => {
    if (!state.current) throw new Error('Session changed');
  },
  HostedChatError: class extends Error {
    constructor(public kind: string) {
      super(kind);
    }
  },
}));
vi.mock('@/lib/api', () => ({
  api: {
    sessionScoped: (...args: unknown[]) => state.api(...args),
    isError: (error: unknown) =>
      !!error && typeof error === 'object' && 'response' in error,
  },
}));
import { HostedChatSubmission } from './hosted-chat-api';
import {
  hostedNativeFilesApi,
  NATIVE_FILE_BYTES,
  validateNativeFiles,
} from './hosted-native-files-api';

const scope = {
  projectPointer: 'p'.repeat(21),
} as HostedChatSubmission['scope'];
const submission = {
  scope,
  projectId: scope.projectPointer,
  assertCurrent: () => {
    if (!state.current) throw new Error('Session changed');
  },
} as HostedChatSubmission;
beforeEach(() => {
  state.current = true;
  state.api.mockReset();
});

describe('native attachment privacy and bounds', () => {
  it('rejects too many, empty, oversized and unsupported files before upload', async () => {
    const valid = new File(['fictional client scope'], 'scope.txt', {
      type: 'text/plain',
    });
    expect(() => validateNativeFiles(Array(5).fill(valid))).toThrow('four');
    expect(() => validateNativeFiles([new File([], 'empty.txt')])).toThrow(
      'Empty',
    );
    const large = new File(['small'], 'scope.txt');
    Object.defineProperty(large, 'size', { value: NATIVE_FILE_BYTES + 1 });
    expect(() => validateNativeFiles([large])).toThrow('20 MB');
    expect(() =>
      validateNativeFiles([new File(['MZ'], 'program.exe')]),
    ).toThrow('supported');
    expect(state.api).not.toHaveBeenCalled();
  });
  it('uploads only to the scoped endpoint and returns metadata, never an arbitrary URL', async () => {
    state.api.mockResolvedValue({
      id: 'f'.repeat(21),
      name: 'scope.txt',
      size: 5,
      mimeType: 'text/plain',
      kind: 'text',
      expiresAt: '2026-10-23T00:00:00Z',
      url: 'https://private.invalid/secret',
    });
    const value = await hostedNativeFilesApi.upload(submission, [
      new File(['Scope'], 'scope.txt', { type: 'text/plain' }),
    ]);
    expect(state.api).toHaveBeenCalledWith(
      '/v1/hosting/ai-files',
      expect.objectContaining({
        method: 'POST',
        data: {
          projectId: scope.projectPointer,
          name: 'scope.txt',
          mimeType: 'text/plain',
          data: 'U2NvcGU=',
        },
      }),
    );
    expect(value[0]).not.toHaveProperty('url');
  });
  it('does not upload after the account changes while a local file is being read', async () => {
    const read = vi
      .spyOn(FileReader.prototype, 'readAsDataURL')
      .mockImplementation(function (this: FileReader) {
        state.current = false;
        Object.defineProperty(this, 'result', {
          value: 'data:text/plain;base64,U2NvcGU=',
        });
        this.onload?.({} as ProgressEvent<FileReader>);
      });
    try {
      await expect(
        hostedNativeFilesApi.upload(submission, [
          new File(['Scope'], 'scope.txt'),
        ]),
      ).rejects.toThrow('Session changed');
    } finally {
      read.mockRestore();
    }
    expect(state.api).not.toHaveBeenCalled();
  });
  it('rejects a late response after switching accounts and does not reveal provider errors', async () => {
    state.api.mockImplementation(async () => {
      state.current = false;
      return { data: [] };
    });
    await expect(hostedNativeFilesApi.list(scope)).rejects.toThrow(
      'Session changed',
    );
    state.current = true;
    state.api.mockRejectedValue({
      response: {
        status: 500,
        data: { message: 'supplier key sk-private provider-secret' },
      },
    });
    await expect(hostedNativeFilesApi.list(scope)).rejects.toThrow(
      'File access could not be confirmed',
    );
  });
  it('requires the captured session before removing access to an exact file', async () => {
    state.current = false;
    await expect(
      hostedNativeFilesApi.remove(scope, 'f'.repeat(21)),
    ).rejects.toThrow('Session changed');
    expect(state.api).not.toHaveBeenCalled();
    state.current = true;
    state.api.mockResolvedValue({ deleted: true });
    await hostedNativeFilesApi.remove(scope, 'f'.repeat(21));
    expect(state.api).toHaveBeenCalledWith(
      '/v1/hosting/ai-files/' + 'f'.repeat(21),
      { method: 'DELETE', params: { projectId: scope.projectPointer } },
    );
  });
  it('normalizes an OS-specific CSV MIME while leaving content validation to the server', async () => {
    state.api.mockResolvedValue({
      id: 'f'.repeat(21),
      name: 'scope.csv',
      size: 5,
      mimeType: 'text/csv',
      kind: 'text',
      expiresAt: '2026-10-23T00:00:00Z',
    });
    await hostedNativeFilesApi.upload(submission, [
      new File(['a,b'], 'scope.csv', { type: 'application/vnd.ms-excel' }),
    ]);
    expect(state.api.mock.calls[0][1].data.mimeType).toBe('text/csv');
    state.api.mockRejectedValue({ response: { status: 409, data: {} } });
    await expect(
      hostedNativeFilesApi.upload(submission, [new File(['a,b'], 'scope.csv')]),
    ).rejects.toThrow('workspace storage limit');
  });
});
