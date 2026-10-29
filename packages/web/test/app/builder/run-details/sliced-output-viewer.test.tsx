/* eslint-disable jest-dom/prefer-to-have-text-content, jest-dom/prefer-to-have-attribute -- This Vitest setup does not install jest-dom matchers. */
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ load: vi.fn(), scope: 'one' }));
vi.mock('i18next', () => ({
  t: (key: string, args?: Record<string, unknown>) =>
    Object.entries(args ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
      key,
    ),
}));
vi.mock(
  '@/app/builder/run-details/sliced-output-loader',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/app/builder/run-details/sliced-output-loader')
    >()),
    loadSlicedOutput: state.load,
    outputSessionKey: () => state.scope,
    subscribeOutputSession: (listener: () => void) => {
      window.addEventListener('storage', listener);
      return () => window.removeEventListener('storage', listener);
    },
  }),
);
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: {
    getToken: () => 'fixture',
    getProjectId: () => 'one',
  },
}));
vi.mock('@/components/custom/smart-output-viewer', () => ({
  SmartOutputViewer: ({ json }: { json: unknown }) => (
    <div data-testid="structured-output">{JSON.stringify(json)}</div>
  ),
}));
vi.mock('@/components/custom/clipboard/copy-button', () => ({
  CopyButton: () => <button>Copy output</button>,
}));
import { SlicedOutputViewer } from '@/app/builder/run-details/sliced-output-viewer';
const base = {
  fileId: '123456789012345678901',
  size: 42905,
  url: '/api/v1/files/123456789012345678901',
};
function show(size = base.size, url = base.url) {
  return render(
    <SlicedOutputViewer
      slicedOutputRef={{ ...base, size, url }}
      authenticated
      downloadLink={<a href="/download">Download output</a>}
    />,
  );
}
beforeEach(() => {
  state.load.mockReset();
  state.scope = 'one';
});

describe('saved output inspection', () => {
  it('automatically displays a 41.9 KB saved output in the existing viewer', async () => {
    const value = { message: 'x'.repeat(42900) };
    state.load.mockResolvedValue(JSON.stringify(value));
    show();
    await waitFor(() =>
      expect(screen.getByTestId('structured-output').textContent).toBe(
        JSON.stringify(value),
      ),
    );
    expect(
      screen
        .getByRole('link', { name: 'Download output' })
        .getAttribute('href'),
    ).toBe('/download');
  });
  it('loads larger outputs on request and searches the full output across pages', async () => {
    const text = 'x'.repeat(45000) + 'needle-at-end';
    state.load.mockResolvedValue(text);
    show(2 * 1024 * 1024);
    expect(state.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'View output' }));
    await screen.findByLabelText('Search output');
    expect(screen.getByRole('status').textContent).toBe('Page 1 of 3');
    fireEvent.change(screen.getByLabelText('Search output'), {
      target: { value: 'needle-at-end' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find next' }));
    expect(screen.getByRole('status').textContent).toBe('Page 3 of 3');
    expect(screen.getByLabelText('Output preview').textContent).toContain(
      'needle-at-end',
    );
    expect(
      screen.getByLabelText('Output preview').textContent!.length,
    ).toBeLessThanOrEqual(20000);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByRole('status').textContent).toBe('Page 2 of 3');
  });
  it('wraps case-insensitive literal search without losing a match', async () => {
    state.load.mockResolvedValue('x'.repeat(45000) + 'NEEDLE [a].');
    show(2 * 1024 * 1024);
    fireEvent.click(screen.getByRole('button', { name: 'View output' }));
    await screen.findByLabelText('Search output');
    fireEvent.change(screen.getByLabelText('Search output'), {
      target: { value: 'needle' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find next' }));
    expect(screen.getByRole('status').textContent).toBe('Page 3 of 3');
    expect(screen.queryAllByText('No matches found')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Search output'), {
      target: { value: '[a].' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find next' }));
    expect(screen.queryAllByText('No matches found')).toHaveLength(0);
    expect(screen.getByText('[a].', { selector: 'mark' }).textContent).toBe(
      '[a].',
    );
  });
  it('advances past a whole emoji and wraps to the first match', async () => {
    state.load.mockResolvedValue('🌏' + 'x'.repeat(20001) + '🌏');
    show(2 * 1024 * 1024);
    fireEvent.click(screen.getByRole('button', { name: 'View output' }));
    await screen.findByLabelText('Search output');
    fireEvent.change(screen.getByLabelText('Search output'), {
      target: { value: '🌏' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find next' }));
    expect(screen.getByRole('status').textContent).toBe('Page 1 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Find next' }));
    expect(screen.getByRole('status').textContent).toBe('Page 2 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Find next' }));
    expect(screen.getByRole('status').textContent).toBe('Page 1 of 2');
  });
  it('offers retry and download when output is unavailable', async () => {
    state.load
      .mockRejectedValueOnce(new Error('expired'))
      .mockResolvedValueOnce('null');
    show();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
    await screen.findByTestId('structured-output');
    expect(state.load).toHaveBeenCalledTimes(2);
  });
  it('retains download for files beyond the browser preview budget', () => {
    show(20 * 1024 * 1024);
    expect(state.load).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole('link', { name: 'Download output' }),
    ).toHaveLength(1);
  });
  it('clears old output and aborts its request on an account/workspace change', async () => {
    state.load
      .mockResolvedValueOnce('"old private output"')
      .mockImplementationOnce(() => new Promise(() => undefined));
    show();
    await screen.findByTestId('structured-output');
    const signal = state.load.mock.calls[0][1] as AbortSignal;
    state.scope = 'two';
    fireEvent(window, new Event('storage'));
    await waitFor(() =>
      expect(screen.queryAllByTestId('structured-output')).toHaveLength(0),
    );
    expect(signal.aborted).toBe(true);
  });
});
