import { LogSliceRef } from '@activepieces/shared';
import { t } from 'i18next';
import { Download, Search } from 'lucide-react';
import {
  ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import { CopyButton } from '@/components/custom/clipboard/copy-button';
import { SmartOutputViewer } from '@/components/custom/smart-output-viewer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUtils } from '@/lib/format-utils';

import {
  AUTO_PREVIEW_BYTES,
  loadSlicedOutput,
  MAX_PREVIEW_BYTES,
  outputSessionKey,
  OutputPreviewTooLarge,
  structuredPreview,
  subscribeOutputSession,
} from './sliced-output-loader';

const PAGE_CHARACTERS = 20000;

export function SlicedOutputViewer({
  slicedOutputRef,
  authenticated = false,
  downloadLink,
}: {
  slicedOutputRef: LogSliceRef;
  authenticated?: boolean;
  downloadLink: ReactNode;
}) {
  const session = useSyncExternalStore(
    subscribeOutputSession,
    outputSessionKey,
    outputSessionKey,
  );
  return (
    <ScopedOutputViewer
      key={`${session}:${slicedOutputRef.fileId}:${slicedOutputRef.url}:${slicedOutputRef.size}`}
      slicedOutputRef={slicedOutputRef}
      authenticated={authenticated}
      downloadLink={downloadLink}
    />
  );
}

function ScopedOutputViewer({
  slicedOutputRef: ref,
  authenticated,
  downloadLink,
}: {
  slicedOutputRef: LogSliceRef;
  authenticated: boolean;
  downloadLink: ReactNode;
}) {
  const [requested, setRequested] = useState(ref.size <= AUTO_PREVIEW_BYTES);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ text: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const { fileId, url, size } = ref;
  const oversized = ref.size > MAX_PREVIEW_BYTES;
  useEffect(() => {
    if (!requested || oversized) return;
    const abort = new AbortController();
    setFailed(false);
    void loadSlicedOutput({ fileId, url, size }, abort.signal, authenticated)
      .then((text) => {
        if (!abort.signal.aborted) setResult({ text });
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          setTooLarge(error instanceof OutputPreviewTooLarge);
          setFailed(true);
        }
      });
    return () => abort.abort();
  }, [fileId, url, size, authenticated, requested, attempt, oversized]);
  const structured = useMemo(
    () => (result ? structuredPreview(result.text) : null),
    [result],
  );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-11">
        <span>
          {t('Saved output · {size}', {
            size: formatUtils.formatStorageSize(ref.size),
          })}
        </span>
        <span className="inline-flex items-center gap-1">
          <Download className="size-4" />
          {downloadLink}
        </span>
      </div>
      {result ? (
        structured ? (
          <SmartOutputViewer json={structured.value} title={t('Output')} />
        ) : (
          <PagedOutput text={result.text} />
        )
      ) : oversized || tooLarge ? (
        <p className="text-sm text-gray-11">
          {t(
            'This output exceeds the 16 MB preview limit. Download the complete output to inspect it.',
          )}
        </p>
      ) : failed ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-danger-11">
            {t(
              'Output could not be loaded. Check your workspace access or retention period, then try again.',
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t('Retry preview')}
          </Button>
        </div>
      ) : requested ? (
        <p role="status" className="text-sm text-gray-11">
          {t('Loading saved output…')}
        </p>
      ) : (
        <Button
          variant="outline"
          className="self-start"
          onClick={() => setRequested(true)}
        >
          {t('View output')}
        </Button>
      )}
    </div>
  );
}

function PagedOutput({ text }: { text: string }) {
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState(-1);
  const [matchLength, setMatchLength] = useState(0);
  const [searched, setSearched] = useState(false);
  const pages = Math.max(1, Math.ceil(text.length / PAGE_CHARACTERS));
  const start = page * PAGE_CHARACTERS;
  const visible = text.slice(start, start + PAGE_CHARACTERS);
  const findNext = () => {
    if (!query) return;
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(literal, 'giu');
    expression.lastIndex = match < 0 ? 0 : match + Math.max(1, matchLength);
    let found = expression.exec(text);
    if (!found && match >= 0) {
      expression.lastIndex = 0;
      found = expression.exec(text);
    }
    setMatch(found?.index ?? -1);
    setMatchLength(found?.[0].length ?? 0);
    setSearched(true);
    if (found) setPage(Math.floor(found.index / PAGE_CHARACTERS));
  };
  const relativeMatch = match - start;
  return (
    <div className="min-w-0 rounded-xl border border-gray-6">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-6 p-3">
        <Input
          aria-label={t('Search output')}
          placeholder={t('Search output')}
          className="min-w-0 flex-1"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setMatch(-1);
            setSearched(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              findNext();
            }
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!query}
          onClick={findNext}
        >
          <Search className="mr-1 size-4" />
          {t('Find next')}
        </Button>
        <CopyButton textToCopy={text} variant="ghost" />
      </div>
      {searched && match < 0 && (
        <p role="status" className="px-3 pt-2 text-sm text-gray-11">
          {t('No matches found')}
        </p>
      )}
      <pre
        tabIndex={0}
        aria-label={t('Output preview')}
        className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-xs leading-5"
      >
        {relativeMatch >= 0 && relativeMatch < visible.length ? (
          <>
            {visible.slice(0, relativeMatch)}
            <mark>
              {visible.slice(relativeMatch, relativeMatch + matchLength)}
            </mark>
            {visible.slice(relativeMatch + matchLength)}
          </>
        ) : (
          visible || t('Empty output')
        )}
      </pre>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-6 p-3">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 0}
          onClick={() => setPage((value) => value - 1)}
        >
          {t('Previous')}
        </Button>
        <span role="status" className="text-xs text-gray-11">
          {t('Page {page} of {pages}', { page: page + 1, pages })}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page === pages - 1}
          onClick={() => setPage((value) => value + 1)}
        >
          {t('Next')}
        </Button>
      </div>
    </div>
  );
}
