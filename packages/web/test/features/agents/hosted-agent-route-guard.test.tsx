// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('i18next', () => ({ t: (value: string) => value }));

const state = vi.hoisted(() => ({ available: true, hosted: true }));
vi.mock('@/features/agents', () => ({
  useAgentsAvailable: () => state.available,
}));
vi.mock('@/features/hosted-billing/service-mode', () => ({
  useHostedBillingEnabled: () => state.hosted,
}));
import { AgentsFlagGuard } from '@/app/guards/agents-flag-guard';
beforeEach(() => {
  state.available = true;
  state.hosted = true;
});
describe('hosted saved-Agent route availability', () => {
  it('opens restored Agent routes when the current hosted runtime and permissions allow it', () => {
    render(
      <MemoryRouter>
        <AgentsFlagGuard>
          <p>Agent catalogue</p>
        </AgentsFlagGuard>
      </MemoryRouter>,
    );
    expect(screen.queryAllByText('Agent catalogue')).toHaveLength(1);
    expect(screen.queryAllByText(/not ready/)).toHaveLength(0);
  });
  it('keeps unavailable runtimes behind a recovery message', () => {
    state.available = false;
    render(
      <MemoryRouter>
        <AgentsFlagGuard>
          <p>Agent catalogue</p>
        </AgentsFlagGuard>
      </MemoryRouter>,
    );
    expect(screen.queryAllByText('Agent catalogue')).toHaveLength(0);
    expect(
      screen.queryAllByText('Agents are not ready in this workspace'),
    ).toHaveLength(1);
  });
});
