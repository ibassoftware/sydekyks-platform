// @vitest-environment jsdom
/* eslint-disable jest-dom/prefer-to-have-text-content, jest-dom/prefer-in-document -- No jest-dom runtime is installed; native Vitest assertions verify the rendered DOM. */
import { FlowRun, FlowRunStatus } from '@activepieces/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {
    run: null as FlowRun | null,
    selectedStep: null as string | null,
    loopsIndexes: {},
    selectFailedStep: vi.fn(),
    userManuallySelectedStepDuringRun: false,
    resumeLiveFollow: vi.fn(),
  },
  fitView: vi.fn(),
}));
vi.mock('i18next', () => ({
  default: { language: 'en' },
  t: (value: string) => value,
}));
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ fitView: mocks.fitView }),
}));
vi.mock('../../builder-hooks', () => ({
  useBuilderStateContext: (select: (state: typeof mocks.state) => unknown) =>
    select(mocks.state),
}));
vi.mock(
  '../../builder-header/flow-status/view-draft-or-edit-flow-button',
  () => ({ EditFlowOrViewDraftButton: () => null }),
);
vi.mock('../utils/flow-canvas-utils', () => ({
  flowCanvasUtils: {
    createFocusStepInGraphParams: (name: string) => ({ name }),
  },
}));
vi.mock('@/features/flow-runs', () => ({
  flowRunUtils: {
    getStatusIcon: () => ({ variant: 'error', Icon: () => null }),
    getStatusContainerClassName: () => '',
    extractStepOutput: () => null,
  },
}));
vi.mock('@/features/flow-runs/components/timeline-bar', () => ({
  isTimelineEmpty: () => true,
  TimelineBar: () => null,
}));
vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: { useFlag: () => ({ data: 60 }) },
}));

import { RunInfoWidget } from './run-info-widget';

const message =
  'Workspace access has expired. Contact your administrator or Sydekyks to renew access before running this Mission.';
const refusal = () =>
  ({
    id: 'refused-run',
    status: FlowRunStatus.FAILED,
    startTime: null,
    finishTime: '2026-10-19T08:48:42.526Z',
    steps: {},
    timeline: [],
    failedStep: { name: 'trigger', displayName: 'Run access', message },
  } as unknown as FlowRun);

beforeEach(() => {
  mocks.state.run = refusal();
  mocks.fitView.mockClear();
  mocks.state.selectFailedStep.mockClear();
});

describe('run access refusal display', () => {
  it('shows the safe expiry reason directly without a dead See error action or invented duration', () => {
    const { container } = render(<RunInfoWidget />);
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(screen.queryByRole('button', { name: 'See error' })).toBeNull();
    expect(container.textContent).not.toContain('Started');
    expect(container.textContent).not.toContain('Took');
    expect(container.textContent).not.toContain('- ,');
  });

  it('preserves navigation to a real failed step and its actual timing', () => {
    mocks.state.run = {
      ...refusal(),
      startTime: '2026-10-19T08:48:40.526Z',
      failedStep: {
        name: 'step_1',
        displayName: 'Calculate value',
        message: 'Ordinary step error',
      },
    };
    render(<RunInfoWidget />);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'See error' }));
    expect(mocks.state.selectFailedStep).toHaveBeenCalledTimes(1);
    expect(mocks.fitView).toHaveBeenCalledWith({ name: 'step_1' });
    expect(screen.getByText('Started:')).toBeTruthy();
    expect(screen.getByText('Took:')).toBeTruthy();
  });

  it('does not render arbitrary non-step backend errors as an access explanation', () => {
    const privateMessage = 'INTERNAL_PROVIDER_DIAGNOSTIC_DO_NOT_DISPLAY';
    mocks.state.run = {
      ...refusal(),
      failedStep: {
        name: 'trigger',
        displayName: 'Run access',
        message: privateMessage,
      },
    };
    const { container } = render(<RunInfoWidget />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.textContent).not.toContain(privateMessage);
  });
});
