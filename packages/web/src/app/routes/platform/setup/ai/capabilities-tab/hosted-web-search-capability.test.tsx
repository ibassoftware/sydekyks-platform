// @vitest-environment jsdom
/* eslint-disable jest-dom/prefer-in-document, jest-dom/prefer-to-have-attribute, jest-dom/prefer-to-have-text-content -- This suite has no jest-dom runtime extension. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  hosted: true,
  legacyError: false,
  project: 'p'.repeat(21),
  session: {
    epoch: 'session-one',
    id: 'u'.repeat(21),
    platformId: 't'.repeat(21),
    kind: 'user',
    expiresAt: null,
  },
  options: vi.fn(),
}));
vi.mock('i18next', () => ({ t: (text: string) => text }));
vi.mock('@/features/hosted-chat/hosted-chat-api', () => ({
  hostedChatApi: { options: state.options },
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getProjectId: () => state.project },
}));
vi.mock('@/features/hosted-onboarding/auth-session', () => ({
  useHostedAuthSession: () => state.session,
}));
vi.mock('@/features/hosted-billing/service-mode', () => ({
  useHostedBillingEnabled: () => state.hosted,
}));
vi.mock('@/features/platform-admin', () => ({
  aiToolConfigQueries: {
    useAiToolConfigs: () => ({
      data: [],
      isError: state.legacyError,
      refetch: vi.fn(),
    }),
  },
  aiProviderQueries: {
    useAiProviderConfigs: () => ({
      data: [],
      isError: state.legacyError,
      refetch: vi.fn(),
    }),
  },
  aiToolConfigMutations: { useDeleteAiToolConfig: () => ({ mutate: vi.fn() }) },
}));
vi.mock(
  '@/app/routes/platform/setup/ai-capabilities/ai-capability-dialog',
  () => ({
    AiCapabilityDialog: ({ children }: { children: ReactNode }) => children,
  }),
);
vi.mock('@/app/components/admin', () => ({
  adminSurface: { card: 'existing-admin-card' },
  adminPageResources: { aiCapabilities: [] },
  AdminPageHeader: ({
    title,
    description,
  }: {
    title: string;
    description: string;
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  ),
  StatusDot: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { CapabilitiesTab } from '@/app/routes/platform/setup/ai/capabilities-tab';

import { HostedWebSearchCapability } from './hosted-web-search-capability';

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.hosted = true;
  state.legacyError = false;
  state.project = 'p'.repeat(21);
  state.session.kind = 'user';
  state.session.epoch = 'session-one';
  state.options
    .mockReset()
    .mockResolvedValue({ nativeFeatures: { webSearch: true } });
});
afterEach(() => client.clear());
function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}
describe('hosted Web Search capability', () => {
  it('shows real readiness and usage guidance without a separate service connection', async () => {
    render(<HostedWebSearchCapability />, { wrapper });
    await screen.findByText('Available in this Command Center');
    expect(screen.getByText('Built into Sydekyks')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Open Sydekyks' }).getAttribute('href'),
    ).toBe('/agents');
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.getByText(/workspace Credit limits/)).toBeTruthy();
    expect(state.options).toHaveBeenCalledWith(
      {
        session: state.session,
        projectPointer: state.project,
        conversationId: null,
      },
      expect.any(AbortSignal),
    );
  });
  it('shows checking while the server result is pending', () => {
    state.options.mockReturnValue(new Promise(() => {}));
    render(<HostedWebSearchCapability />, { wrapper });
    expect(screen.getByRole('status').textContent).toBe(
      'Checking availability…',
    );
    expect(screen.queryByText('Available in this Command Center')).toBeNull();
  });
  it.each([false, undefined])(
    'does not advertise availability when readiness is %s',
    async (webSearch) => {
      state.options.mockResolvedValue({ nativeFeatures: { webSearch } });
      render(<HostedWebSearchCapability />, { wrapper });
      await screen.findByText('Currently unavailable in this Command Center');
      expect(screen.getByText(/Check workspace access/)).toBeTruthy();
    },
  );
  it('offers a retry after a failed check and shows the new result', async () => {
    state.options
      .mockRejectedValueOnce(new Error('Synthetic unavailable'))
      .mockResolvedValueOnce({ nativeFeatures: { webSearch: true } });
    render(<HostedWebSearchCapability />, { wrapper });
    await screen.findByRole('alert');
    expect(screen.queryByText('Available in this Command Center')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry availability check' }),
    );
    await screen.findByText('Available in this Command Center');
  });
  it('does not query without a Command Center or authenticated user', () => {
    state.project = '';
    state.session.kind = 'anonymous';
    render(<HostedWebSearchCapability />, { wrapper });
    expect(
      screen.getByText('Select a Command Center to check availability'),
    ).toBeTruthy();
    expect(state.options).not.toHaveBeenCalled();
  });
  it('drops old readiness when the selected Command Center changes', async () => {
    state.options
      .mockResolvedValueOnce({ nativeFeatures: { webSearch: true } })
      .mockReturnValueOnce(new Promise(() => {}));
    const view = render(<HostedWebSearchCapability />, { wrapper });
    await screen.findByText('Available in this Command Center');
    state.project = 'q'.repeat(21);
    state.session.epoch = 'session-two';
    view.rerender(<HostedWebSearchCapability />);
    await waitFor(() => expect(state.options).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('status').textContent).toBe(
      'Checking availability…',
    );
    expect(screen.queryByText('Available in this Command Center')).toBeNull();
  });
  it('replaces the hosted catalogue row even if legacy service configuration fails', async () => {
    state.legacyError = true;
    render(<CapabilitiesTab />, { wrapper });
    await screen.findByText('Available in this Command Center');
    expect(screen.getAllByText('Built into Sydekyks')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Web Search' })).toBeTruthy();
  });
  it('retains the existing provider connection flow for self-hosted installations', () => {
    state.hosted = false;
    render(<CapabilitiesTab />, { wrapper });
    expect(screen.getByText('Web Search')).toBeTruthy();
    expect(screen.queryByText('Built into Sydekyks')).toBeNull();
    expect(
      screen.getAllByRole('button', { name: 'Connect' }).length,
    ).toBeGreaterThan(0);
    expect(state.options).not.toHaveBeenCalled();
  });
});
