// @vitest-environment jsdom
import { AIProviderName } from '@activepieces/core-utils';
import { AgentConfig } from '@activepieces/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ fetching: false }));
const keyId = 'k'.repeat(21);
vi.mock('i18next', () => ({
  t: (key: string, values?: Record<string, string>) =>
    key.replace('{name}', values?.name ?? ''),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      managedAvailable: true,
      keys: [{ id: 'k'.repeat(21), name: 'Team key' }],
    },
    isFetching: control.fetching,
    error: null,
  }),
}));
vi.mock('@/features/hosted-chat/hosted-chat-api', () => ({
  hostedChatApi: { options: vi.fn() },
}));
vi.mock('@/features/hosted-onboarding/auth-session', () => ({
  useHostedAuthSession: () => ({ epoch: 'epoch', kind: 'user' }),
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    disabled,
    onValueChange,
    children,
  }: {
    value: string;
    disabled: boolean;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      aria-label="Agent AI provider"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectItem: ({
    value,
    disabled,
    children,
  }: {
    value: string;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
}));

import { HostedAgentProviderField } from '@/features/agents/hosted-agent-provider-field';

beforeEach(() => {
  control.fetching = false;
});
describe('hosted Agent provider configuration', () => {
  it('shows Sydekyks and named BYOK keys without underlying model details', () => {
    const changed = vi.fn();
    const view = render(
      <HostedAgentProviderField
        projectId={'p'.repeat(21)}
        config={AgentConfig.parse({ instructions: 'Help' })}
        onChange={changed}
      />,
    );
    expect(screen.getByRole('combobox').matches(':disabled')).toBe(false);
    expect(
      screen.getAllByRole('option').map((option) => option.textContent),
    ).toContain('Sydekyks');
    expect(
      screen.getAllByRole('option').map((option) => option.textContent),
    ).toContain('BYOK · Team key');
    const content = view.container.textContent;
    expect(content).not.toContain('deepseek-flash');
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: keyId },
    });
    expect(changed).toHaveBeenCalledWith({
      provider: AIProviderName.DEEPSEEK,
      providerConfigId: keyId,
      modelName: 'deepseek-flash',
      modelTierId: null,
    });
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'managed' },
    });
    expect(changed).toHaveBeenLastCalledWith({
      provider: AIProviderName.ACTIVEPIECES,
      providerConfigId: null,
      modelName: 'sydekyks',
      modelTierId: null,
    });
  });
  it('keeps old unsupported providers visibly unavailable until the user chooses a supported one', () => {
    render(
      <HostedAgentProviderField
        projectId={'p'.repeat(21)}
        config={AgentConfig.parse({
          instructions: 'Help',
          provider: AIProviderName.OPENAI,
          modelName: 'private-model',
        })}
        onChange={vi.fn()}
      />,
    );
    const alertText = screen.getByRole('alert').textContent;
    expect(alertText).toContain('Choose an available provider');
    const selected = screen
      .getAllByRole('option')
      .filter((option) => (option as HTMLOptionElement).selected)
      .map((option) => option.textContent);
    expect(selected).toEqual(['Configured AI provider unavailable']);
    expect(screen.queryAllByText('private-model')).toHaveLength(0);
  });
  it('disables provider changes while metadata is refreshing', () => {
    control.fetching = true;
    render(
      <HostedAgentProviderField
        projectId={'p'.repeat(21)}
        config={AgentConfig.parse({ instructions: 'Help' })}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('combobox').matches(':disabled')).toBe(true);
  });
});
