/**
 * @vitest-environment jsdom
 */
/* eslint-disable jest-dom/prefer-in-document -- @testing-library/jest-dom is not a dependency of packages/web */
/* eslint-disable testing-library/no-container, testing-library/no-node-access -- <video> has no implicit ARIA role */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let teamProjectsLimit: number | null = 0;
let edition = 'cloud';
const createProject = vi.fn();

vi.mock('i18next', () => ({ t: (key: string) => key }));

vi.mock('lucide-react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Crown: (props: Record<string, unknown>) =>
    React.createElement('span', { ...props, 'data-testid': 'crown' }),
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
vi.mock('@/features/billing/stores/manage-plan-dialog-state', () => ({
  useManagePlanDialogStore: () => ({ openDialog: vi.fn() }),
}));
vi.mock('@/features/billing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useManagePlanDialogStore: () => ({ openDialog: vi.fn() }),
}));
vi.mock('@/features/connections', () => ({
  globalConnectionsQueries: {
    useGlobalConnections: () => ({ data: { data: [] }, isLoading: false }),
  },
}));
vi.mock('@/features/projects', () => ({
  projectCollectionUtils: {
    invalidate: vi.fn(),
    useCreateProject: () => ({ mutate: createProject, isPending: false }),
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
    <button {...rest} data-testid="new-project-trigger">
      {children}
    </button>
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
import { FeatureTeaser } from '@/app/components/feature-teaser';
import { CreateProjectButton } from '@/features/projects/components/create-project-button';

const renderWithQueryClient = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  );

beforeEach(() => {
  createProject.mockClear();
});

describe('release feature availability', () => {
  it.each(['ce', 'ee', 'cloud'])('retains team creation controls in %s for every plan and button variant', (currentEdition) => {
    edition = currentEdition;
    for (const limit of [0, 3, null]) {
      teamProjectsLimit = limit;
      for (const variant of ['full', 'icon']) {
        const ui = variant === 'full'
          ? <CreateProjectButton variant="full" projects={[]} />
          : <CreateProjectButton variant="icon" projects={[]} />;
        const { unmount } = renderWithQueryClient(ui);
        expect(screen.getByRole('button')).toBeDefined();
        expect(screen.queryByTestId('crown') !== null).toBe(limit === 0);
        expect(createProject).not.toHaveBeenCalled();
        unmount();
      }
    }
  });

  it('omits upstream sales from a Community feature teaser', () => {
    edition = 'ce';
    render(<FeatureTeaser featureKey="API" title="Enable API Keys" description="" />);
    expect(screen.queryByRole('button', { name: /contact sales/i })).toBeNull();
  });

  it('omits upstream sales from a Community feature sample', () => {
    edition = 'ce';
    render(<FeatureSample locked title="Unlock Audit Logs" featureKey="AUDIT_LOGS"><div /></FeatureSample>);
    expect(screen.queryByRole('button', { name: /contact sales/i })).toBeNull();
  });
});
