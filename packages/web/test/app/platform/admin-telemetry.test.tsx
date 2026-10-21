/**
 * @vitest-environment jsdom
 */
/* eslint-disable jest-dom/prefer-in-document, jest-dom/prefer-to-have-attribute -- @testing-library/jest-dom is not a dependency of packages/web */
import {
  ApEdition,
  PlatformAdminSurface,
  TelemetryEventName,
} from '@activepieces/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let teamProjectsLimit: number | null = 0;
let edition: ApEdition = ApEdition.CLOUD;
const capture = vi.fn();

vi.mock('i18next', () => ({ t: (key: string) => key }));

vi.mock('@/components/providers/telemetry-provider', () => ({
  useTelemetry: () => ({ capture }),
}));

vi.mock('@/hooks/platform-hooks', () => ({
  platformHooks: {
    useCurrentPlatform: () => ({
      platform: {
        plan: {
          billedTeamProjectsLimit: teamProjectsLimit,
          globalConnectionsEnabled: false,
        },
      },
    }),
  },
}));
vi.mock('@/hooks/user-hooks', () => ({
  userHooks: {
    getCurrentUserPlatformRole: () => 'ADMIN',
    useCurrentUser: () => ({ data: undefined }),
  },
}));
vi.mock('@/hooks/authorization-hooks', () => ({
  useIsPlatformAdmin: () => true,
}));
vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: {
    useFlag: () => ({ data: edition }),
    useFlags: () => ({ data: {} }),
  },
}));
vi.mock('@/features/billing/hooks/billing-dialog-hooks', () => ({
  billingDialogHooks: {
    useManagePlanDialogStore: () => ({ openDialog: vi.fn() }),
  },
}));
vi.mock('@/features/connections', () => ({
  globalConnectionsQueries: {
    useGlobalConnections: () => ({ data: { data: [] }, isLoading: false }),
  },
}));
vi.mock('@/features/projects', () => ({
  projectCollectionUtils: {
    invalidate: vi.fn(),
    useCreateProject: () => ({ mutate: vi.fn(), isPending: false }),
  },
}));
vi.mock('@/components/custom/global-connection-utils', () => ({
  DefaultTag: () => null,
}));
vi.mock('@/components/custom/multi-select-piece-property', () => ({
  MultiSelectPieceProperty: () => null,
}));
vi.mock('@/components/ui/sonner', () => ({ internalErrorToast: vi.fn() }));
vi.mock('@/components/custom/animated-icon-button', () => ({
  AnimatedIconButton: ({
    children,
    icon: _icon,
    iconSize: _iconSize,
    ...rest
  }: React.PropsWithChildren<Record<string, unknown>>) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock('@/components/icons/plus', () => ({ PlusIcon: () => null }));
vi.mock('@/components/ui/sidebar-shadcn', () => ({
  SidebarMenuButton: ({
    children,
    ...rest
  }: React.PropsWithChildren<Record<string, unknown>>) => (
    <button {...rest}>{children}</button>
  ),
}));

import { FeatureSample } from '@/app/components/feature-sample';
import { UpgradeFeatureDialog } from '@/features/billing';
import { CreateProjectButton } from '@/features/projects/components/create-project-button';
import { ADMIN_CONTROL_ATTRIBUTE, AdminControl } from '@/lib/admin-control';

const renderWithQueryClient = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );

const usedTeamProjects = (count: number) =>
  Array.from({ length: count }, () => ({ type: 'TEAM' })) as never;

const capturedNames = () => capture.mock.calls.map(([event]) => event.name);

const capturedPayload = (name: TelemetryEventName) =>
  capture.mock.calls.find(([event]) => event.name === name)?.[0].payload;

beforeEach(() => {
  teamProjectsLimit = 0;
  edition = ApEdition.CLOUD;
  capture.mockClear();
  vi.stubGlobal('open', vi.fn());
});

describe('platform admin telemetry', () => {
  it('reports the upgrade click from the sample overlay with its tier', () => {
    render(
      <FeatureSample
        locked
        title="Unlock Audit Logs"
        tier="enterprise"
        featureKey="AUDIT_LOGS"
      >
        <div />
      </FeatureSample>,
    );
    fireEvent.click(screen.getByRole('button', { name: /upgrade to/i }));
    expect(
      capturedPayload(TelemetryEventName.PLATFORM_ADMIN_UPGRADE_CLICKED),
    ).toEqual({
      feature: 'AUDIT_LOGS',
      tier: 'enterprise',
      surface: PlatformAdminSurface.SAMPLE,
    });
  });

  it('cannot emit an upstream sales enquiry from unavailable Community controls', () => {
    edition = ApEdition.COMMUNITY;
    render(<FeatureSample locked title="Unlock Audit Logs" featureKey="AUDIT_LOGS"><div /></FeatureSample>);
    expect(screen.queryByRole('button', { name: /contact sales/i })).toBeNull();
    expect(capturedPayload(TelemetryEventName.PLATFORM_ADMIN_SALES_CONTACTED)).toBeUndefined();
  });

  it('does not emit gate telemetry for hidden team creation', () => {
    renderWithQueryClient(<CreateProjectButton variant="icon" projects={[]} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it('names the feature by its stable key on every surface, not the title', () => {
    render(
      <UpgradeFeatureDialog
        open
        onOpenChange={vi.fn()}
        featureKey="PROJECTS"
        title="Unlock Projects"
        description=""
        tier="team"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /upgrade plan/i }));
    expect(
      capturedPayload(TelemetryEventName.PLATFORM_ADMIN_UPGRADE_CLICKED),
    ).toEqual({
      feature: 'PROJECTS',
      tier: 'team',
      surface: PlatformAdminSurface.DIALOG,
    });
  });

  it('keeps unavailable team creation silent even when a plan has room', () => {
    teamProjectsLimit = 3;
    renderWithQueryClient(<CreateProjectButton variant="full" projects={[]} />);
    expect(screen.queryByRole('button', { name: /new project/i })).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });
});
