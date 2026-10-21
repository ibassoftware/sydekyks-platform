/** @vitest-environment jsdom */
/* eslint-disable jest-dom/prefer-in-document, jest-dom/prefer-enabled-disabled, jest-dom/prefer-checked -- @testing-library/jest-dom is not a dependency of packages/web */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TodoView } from './todo-api';
import { TodoResolutionPage, TodoResolutionView } from './todo-resolution-page';

const fixture = vi.hoisted(() => ({
  kind: 'user',
  get: vi.fn(),
  resolve: vi.fn(),
  assertSession: vi.fn(),
}));
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@/features/hosted-onboarding/auth-session', () => ({
  useHostedAuthSession: () => ({ kind: fixture.kind, epoch: 'test-session' }),
  assertAuthSession: (...args: unknown[]) => fixture.assertSession(...args),
}));
vi.mock('@/components/custom/full-logo', () => ({
  FullLogo: () => <span>sydekyks</span>,
}));
vi.mock('@/lib/api', () => ({
  api: {
    isError: (value: unknown) =>
      !!value && typeof value === 'object' && 'response' in value,
  },
}));
vi.mock('./todo-api', () => ({
  todoApi: {
    get: (...args: unknown[]) => fixture.get(...args),
    resolve: (...args: unknown[]) => fixture.resolve(...args),
  },
}));

function task(overrides: Partial<TodoView> = {}): TodoView {
  return {
    id: 'task1',
    projectId: 'project1',
    title: 'Review the proposal',
    description: 'Please check the client scope before work begins.',
    statusOptions: [
      {
        name: 'Approve',
        description: 'The scope is ready.',
        variant: 'primary',
        continueFlow: true,
      },
      {
        name: 'Request changes',
        description: 'The scope needs more work.',
        variant: 'secondary',
        continueFlow: false,
      },
    ],
    status: null,
    resolved: false,
    message: null,
    canResolve: true,
    assigneeId: 'user1',
    created: '2026-10-21T00:00:00Z',
    updated: '2026-10-21T00:00:00Z',
    ...overrides,
  };
}
function view(
  overrides: Partial<React.ComponentProps<typeof TodoResolutionView>> = {},
) {
  const submit = vi.fn();
  render(
    <TodoResolutionView
      task={task()}
      suggestedStatus={null}
      submitting={false}
      mustReload={false}
      reloading={false}
      onReload={vi.fn()}
      onSubmit={submit}
      {...overrides}
    />,
  );
  return submit;
}
function Destination() {
  return <p>{useLocation().pathname + useLocation().search}</p>;
}
function page() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/todos/task1/resolve?status=Approve']}>
        <Routes>
          <Route path="/todos/:id/resolve" element={<TodoResolutionPage />} />
          <Route path="/sign-in" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  fixture.kind = 'user';
  fixture.get.mockReset();
  fixture.resolve.mockReset();
  fixture.assertSession.mockReset();
});

describe('task decision confirmation', () => {
  it('requires an explicit decision and submits the selected status and trimmed message', () => {
    const submit = view();
    expect(
      (
        screen.getByRole('button', {
          name: 'Submit decision',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('radio', { name: /Approve The scope is ready/ }),
    );
    fireEvent.change(screen.getByLabelText('Message (optional)'), {
      target: { value: '  Scope checked.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit decision' }));
    expect(submit).toHaveBeenCalledWith({
      status: 'Approve',
      message: 'Scope checked.',
    });
  });
  it('preselects only a real status without submitting on link open', () => {
    const submit = view({ suggestedStatus: 'Approve' });
    expect(
      (
        screen.getByRole('radio', {
          name: /Approve The scope is ready/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
  it('does not turn an invalid URL status into an actionable decision', () => {
    view({ suggestedStatus: 'evil' });
    expect(
      (
        screen.getByRole('button', {
          name: 'Submit decision',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it('renders completed tasks read only and escapes task content', () => {
    view({
      task: task({
        title: '<script>doNotRun()</script>',
        resolved: true,
        status: task().statusOptions[0],
        message: '<img src=x onerror=bad()>',
      }),
    });
    expect(screen.getByText('<script>doNotRun()</script>')).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=bad()>')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Submit decision' }),
    ).toBeNull();
    // eslint-disable-next-line testing-library/no-node-access -- Inspect DOM tags to prove untrusted task text cannot become executable markup.
    expect(document.querySelector('article script, article img')).toBeNull();
  });
  it('shows read-only guidance when the account cannot resolve the task', () => {
    const submit = view({ task: task({ canResolve: false }) });
    expect(screen.getByText('Waiting for a decision')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
  it('holds the form after an uncertain result until the user reloads the task', () => {
    const reload = vi.fn();
    const submit = view({
      mustReload: true,
      suggestedStatus: 'Approve',
      onReload: reload,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit decision' }));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload task' }));
    expect(reload).toHaveBeenCalledOnce();
  });
  it('redirects an anonymous link to sign-in with its task destination and no read request', async () => {
    fixture.kind = 'anonymous';
    page();
    expect(
      await screen.findByText(
        '/sign-in?from=%2Ftodos%2Ftask1%2Fresolve%3Fstatus%3DApprove',
      ),
    ).toBeTruthy();
    expect(fixture.get).not.toHaveBeenCalled();
  });
  it('only reads on open, then resolves through an explicit submission', async () => {
    fixture.get.mockResolvedValue(task());
    fixture.resolve.mockResolvedValue(
      task({ resolved: true, status: task().statusOptions[0] }),
    );
    page();
    await screen.findByText('Review the proposal');
    expect(fixture.resolve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit decision' }));
    expect(await screen.findByText('Decision recorded')).toBeTruthy();
    expect(fixture.resolve).toHaveBeenCalledOnce();
    expect(fixture.resolve).toHaveBeenCalledWith('task1', {
      status: 'Approve',
    });
  });
  it('refuses a stale account before sending a decision', async () => {
    fixture.get.mockResolvedValue(task());
    page();
    await screen.findByText('Review the proposal');
    fixture.assertSession.mockImplementation(() => {
      throw new Error('Session changed');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit decision' }));
    await screen.findByRole('alert');
    expect(fixture.resolve).not.toHaveBeenCalled();
  });
  it('never automatically repeats a failed decision and reloads the recorded server result', async () => {
    fixture.get
      .mockResolvedValueOnce(task())
      .mockResolvedValue(
        task({ resolved: true, status: task().statusOptions[0] }),
      );
    fixture.resolve.mockRejectedValue(new Error('connection lost'));
    page();
    await screen.findByText('Review the proposal');
    fireEvent.click(screen.getByRole('button', { name: 'Submit decision' }));
    await screen.findByRole('alert');
    expect(fixture.resolve).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Reload task' }));
    await screen.findByText('Decision recorded');
    expect(fixture.resolve).toHaveBeenCalledOnce();
  });
  it.each([403, 404])(
    'does not expose task content after a %s response',
    async (status) => {
      fixture.get.mockRejectedValue({ response: { status } });
      page();
      await screen.findByText('Task unavailable');
      expect(screen.queryByText('Review the proposal')).toBeNull();
      expect(fixture.resolve).not.toHaveBeenCalled();
    },
  );
});
