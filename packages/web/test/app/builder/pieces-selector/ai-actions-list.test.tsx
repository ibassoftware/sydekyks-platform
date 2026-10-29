// @vitest-environment jsdom
import { FlowActionType } from '@activepieces/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  hosted: true,
  configured: false as boolean | undefined,
  add: vi.fn(),
  toast: vi.fn(),
  capture: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('react-router-dom', () => ({ useNavigate: () => state.navigate }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/components/providers/telemetry-provider', () => ({
  useTelemetry: () => ({ capture: state.capture }),
}));
vi.mock('@/features/hosted-billing/service-mode', () => ({
  useHostedBillingEnabled: () => state.hosted,
}));
vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: { useFlag: () => ({ data: state.configured }) },
}));
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('@/components/custom/card-list', () => ({
  CardListItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));
vi.mock('@/features/pieces', () => ({
  usePieceSearchContext: () => ({ searchQuery: '' }),
  PieceIcon: () => null,
}));
vi.mock('@/app/builder/builder-hooks', () => ({
  useBuilderStateContext: () => [state.add],
}));
vi.mock('@/app/builder/pieces-selector/piece-actions-or-triggers-list', () => ({
  convertStepMetadataToPieceSelectorItems: () =>
    ['run_agent', 'askAi', 'generateImage'].map((name) => ({
      type: FlowActionType.PIECE,
      pieceMetadata: { pieceName: '@activepieces/piece-ai' },
      actionOrTrigger: {
        name,
        displayName: name === 'run_agent' ? 'Run Agent' : name,
      },
    })),
}));

import { AIPieceActionsList } from '@/app/builder/pieces-selector/ai-tab-content/ai-actions-list';

const show = () =>
  render(
    <AIPieceActionsList
      hidePieceIconAndDescription={false}
      stepMetadataWithSuggestions={{} as never}
      operation={{} as never}
    />,
  );
beforeEach(() => {
  vi.clearAllMocks();
  state.hosted = true;
  state.configured = false;
});

describe('AI step selection', () => {
  it.each([false, undefined])(
    'opens a hosted Run Sydekyk step with legacy setup flag %s',
    (configured) => {
      state.configured = configured;
      show();
      fireEvent.click(screen.getByRole('button', { name: 'Run Sydekyk' }));
      expect(state.add).toHaveBeenCalledWith(
        expect.objectContaining({
          pieceSelectorItem: expect.objectContaining({
            actionOrTrigger: expect.objectContaining({ name: 'run_agent' }),
          }),
          selectStepAfter: true,
        }),
      );
      expect(state.toast).not.toHaveBeenCalled();
      expect(state.navigate).not.toHaveBeenCalled();
    },
  );
  it('also permits hosted text AI without a self-hosted OpenAI connection', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'askAi' }));
    expect(state.add).toHaveBeenCalledOnce();
    expect(state.toast).not.toHaveBeenCalled();
  });
  it('keeps unsupported managed image actions out of the hosted picker', () => {
    show();
    expect(
      screen.queryAllByRole('button', { name: 'generateImage' }),
    ).toHaveLength(0);
  });
  it('preserves self-hosted provider setup and its navigation', () => {
    state.hosted = false;
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Run Sydekyk' }));
    expect(state.add).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      'Connect to OpenAI',
      expect.any(Object),
    );
    state.toast.mock.calls[0][1].action.onClick();
    expect(state.navigate).toHaveBeenCalledWith('/platform/ai');
  });
  it('preserves configured self-hosted AI and image actions', () => {
    state.hosted = false;
    state.configured = true;
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Run Sydekyk' }));
    expect(state.add).toHaveBeenCalledOnce();
    expect(state.toast).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole('button', { name: 'generateImage' }),
    ).toHaveLength(1);
  });
});
