// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ hosted: true }));
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@/features/hosted-billing/service-mode', () => ({
  useHostedBillingEnabled: () => control.hosted,
}));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { AddToolDropdown } from '@/features/agents/agent-tools/add-agent-tool-dropwdown';

describe('hosted Agent tools', () => {
  it('offers supported app and Mission tools without remote MCP', () => {
    control.hosted = true;
    render(
      <AddToolDropdown>
        <button>Add</button>
      </AddToolDropdown>,
    );
    expect(screen.getAllByText('Piece tool')).toHaveLength(1);
    expect(screen.getAllByText('Flow tool')).toHaveLength(1);
    expect(screen.queryAllByText('Mcp server')).toHaveLength(0);
  });
  it('preserves remote MCP for self hosted workspaces', () => {
    control.hosted = false;
    render(
      <AddToolDropdown>
        <button>Add</button>
      </AddToolDropdown>,
    );
    expect(screen.getAllByText('Mcp server')).toHaveLength(1);
  });
});
