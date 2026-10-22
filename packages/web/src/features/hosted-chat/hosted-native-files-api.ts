import { z } from 'zod';

import { api } from '@/lib/api';

import {
  assertHostedChatScope,
  HostedChatError,
  HostedChatScope,
  HostedChatSubmission,
} from './hosted-chat-api';

export const NATIVE_FILE_BYTES = 20 * 1024 * 1024;
export const NATIVE_FILE_COUNT = 4;
export const NATIVE_FILE_ACCEPT =
  '.pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.gif';

const FileMetadata = z.object({
  id: z.string().length(21),
  name: z.string().min(1).max(255),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  kind: z.enum(['text', 'image', 'document']),
  expiresAt: z.string(),
  pageCount: z.number().int().nonnegative().optional(),
});
export type NativeFileMetadata = z.infer<typeof FileMetadata>;

export function validateNativeFiles(files: File[]): void {
  if (files.length > NATIVE_FILE_COUNT)
    throw new Error('Attach up to four files per message.');
  if (files.some((file) => file.size === 0))
    throw new Error('Empty files cannot be read.');
  if (files.reduce((total, file) => total + file.size, 0) > NATIVE_FILE_BYTES)
    throw new Error('Attached files must total 20 MB or less.');
  if (
    files.some(
      (file) =>
        !/\.(pdf|docx|txt|md|csv|json|png|jpe?g|webp|gif)$/i.test(file.name),
    )
  )
    throw new Error('Use a PDF, Word document, text file or supported image.');
}

function encode(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result.slice(reader.result.indexOf(',') + 1))
        : reject(new Error('The file could not be read. Attach it again.'));
    reader.onerror = () =>
      reject(new Error('The file could not be read. Attach it again.'));
    reader.readAsDataURL(file);
  });
}

function declaredMime(file: File): string {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return (
    (
      {
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        txt: 'text/plain',
        md: 'text/markdown',
        csv: 'text/csv',
        json: 'application/json',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
      } as Record<string, string>
    )[extension ?? ''] ?? 'application/octet-stream'
  );
}

async function request(
  scope: HostedChatScope,
  path: string,
  config: Parameters<typeof api.sessionScoped>[1],
): Promise<unknown> {
  assertHostedChatScope(scope);
  try {
    const value = await api.sessionScoped<unknown>(path, config);
    assertHostedChatScope(scope);
    return value;
  } catch (error) {
    assertHostedChatScope(scope);
    if (error instanceof HostedChatError) throw error;
    const status = api.isError(error) ? error.response?.status : undefined;
    if (status === 401 || status === 403) throw new HostedChatError('access');
    if (status === 413 || status === 409)
      throw new Error(
        'This file exceeds the file or workspace storage limit. Remove an unused upload or choose a smaller file.',
      );
    if (status === 400 || status === 422)
      throw new Error(
        'This file could not be prepared. Use a supported, unencrypted document with at most 20 pages, or a smaller image.',
      );
    if (status === 429)
      throw new Error(
        'Files are being prepared. Wait a moment before trying again.',
      );
    throw new Error(
      'File access could not be confirmed. Refresh the file list before trying again.',
    );
  }
}

export const hostedNativeFilesApi = {
  async upload(
    submission: HostedChatSubmission,
    files: File[],
  ): Promise<NativeFileMetadata[]> {
    validateNativeFiles(files);
    const uploaded: NativeFileMetadata[] = [];
    for (const file of files) {
      submission.assertCurrent();
      const data = await encode(file);
      submission.assertCurrent();
      const value = await request(submission.scope, '/v1/hosting/ai-files', {
        method: 'POST',
        data: {
          projectId: submission.projectId,
          name: file.name,
          mimeType: declaredMime(file),
          data,
        },
      });
      submission.assertCurrent();
      uploaded.push(FileMetadata.parse(value));
    }
    return uploaded;
  },
  async list(scope: HostedChatScope): Promise<NativeFileMetadata[]> {
    const value = await request(scope, '/v1/hosting/ai-files', {
      method: 'GET',
      params: { projectId: scope.projectPointer },
    });
    return z.object({ data: z.array(FileMetadata).max(20) }).parse(value).data;
  },
  async remove(scope: HostedChatScope, id: string): Promise<void> {
    if (!z.string().length(21).safeParse(id).success)
      throw new Error('Invalid file selection. Refresh the list.');
    await request(scope, `/v1/hosting/ai-files/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      params: { projectId: scope.projectPointer },
    });
  },
};
