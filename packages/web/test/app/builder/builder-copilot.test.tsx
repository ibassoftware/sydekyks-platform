// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  chat: { beforeSend: () => true, onRunStateChange: (_active: boolean) => {}, onConversationCreated: (_id: string) => {}, conversationId: null },
  query: async (): Promise<unknown> => null,
  state: { readonly: false, saving: false, pendingDebouncedUpdates: false, isPublishing: false, selectedStep: 'trigger', rightSidebar: 'settings', flowVersion: { id: 'version', flowId: 'flow', updated: 'old', displayName: 'Test mission', trigger: { name: 'trigger', displayName: 'Trigger' } }, setReadOnly: vi.fn(), setCopilotRunning: vi.fn(), incrementCopilotRevision: vi.fn(), setFlow: vi.fn(), setVersion: vi.fn(), selectStepByName: vi.fn(), setRightSidebar: vi.fn() },
  get: vi.fn(),
}));

vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@/lib/authentication-session', () => ({ authenticationSession: { getCurrentUserId: () => 'user' } }));
vi.mock('react-router-dom', () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()] }));
vi.mock('@tanstack/react-query', () => ({ useQuery: ({ queryFn }: { queryFn: () => Promise<unknown> }) => { control.query = queryFn; return {}; } }));
vi.mock('@/features/flows/api/flows-api', () => ({ flowsApi: { get: control.get } }));
vi.mock('@/app/builder/builder-hooks', () => { const store = { getState: () => control.state }; return { useBuilderStore: () => store, useBuilderStateContext: (selector: (state: typeof control.state) => unknown) => selector(control.state) }; });
vi.mock('@/app/routes/chat-with-ai/ai-chat-box', () => ({ AIChatBox: (props: typeof control.chat) => { control.chat = props; return <div>Chat</div>; } }));

import { BuilderCopilot } from '@/app/builder/builder-copilot';

describe('builder copilot synchronization', () => {
  beforeEach(() => {
    sessionStorage.clear();
    control.state.readonly = false;
    control.state.saving = false;
    control.state.pendingDebouncedUpdates = false;
    control.state.isPublishing = false;
    control.state.flowVersion.updated = 'old';
    control.state.setReadOnly.mockReset().mockImplementation((value: boolean) => { control.state.readonly = value; });
    control.state.setCopilotRunning.mockReset();
    control.state.setVersion.mockReset().mockImplementation(() => { control.state.readonly = false; });
    control.state.selectStepByName.mockReset();
    control.get.mockReset().mockResolvedValue({ id: 'flow', version: { ...control.state.flowVersion, updated: 'new' } });
  });
  it('blocks sending during a manual save and locks edits before dispatch', () => {
    render(<BuilderCopilot onClose={() => {}} />);
    control.state.saving = true;
    expect(control.chat.beforeSend()).toBe(false);
    expect(control.state.readonly).toBe(false);
    control.state.saving = false;
    control.state.pendingDebouncedUpdates = true;
    expect(control.chat.beforeSend()).toBe(false);
    control.state.pendingDebouncedUpdates = false;
    act(() => { expect(control.chat.beforeSend()).toBe(true); });
    expect(control.state.readonly).toBe(true);
  });
  it('keeps editing locked across graph refresh and until the final refresh completes', async () => {
    render(<BuilderCopilot onClose={() => {}} />);
    act(() => control.chat.onRunStateChange(true));
    await act(async () => { await control.query(); });
    expect(control.state.setVersion).toHaveBeenCalled();
    expect(control.state.readonly).toBe(true);
    let finish: ((value: unknown) => void) | undefined;
    control.get.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    act(() => control.chat.onRunStateChange(false));
    expect(control.state.readonly).toBe(true);
    await act(async () => { finish?.({ id: 'flow', version: { ...control.state.flowVersion, updated: 'new' } }); });
    expect(control.state.readonly).toBe(false);
  });
  it('preserves an existing read-only state and reports refresh failures in place', async () => {
    control.state.readonly = true;
    control.get.mockRejectedValue(new Error('Unavailable'));
    render(<BuilderCopilot onClose={() => {}} />);
    act(() => control.chat.onRunStateChange(true));
    await act(async () => { await control.query(); });
    expect(screen.getByRole('alert').textContent).toContain('Could not refresh this mission.');
    await act(async () => { control.chat.onRunStateChange(false); });
    expect(control.state.readonly).toBe(true);
  });
})
