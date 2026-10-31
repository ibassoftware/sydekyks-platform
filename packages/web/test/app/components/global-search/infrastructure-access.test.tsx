// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlobalSearchResults } from '@/app/components/global-search/use-global-search-results';

const state = vi.hoisted(() => ({
  operator: false,
  history: [] as {
    id: string;
    type: string;
    label: string;
    href: string;
    accessedAt: number;
  }[],
}));
vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: (value: unknown) => value,
  useQuery: () => ({ data: [], isLoading: false }),
}));
vi.mock('@/features/hosted-operator/operator-api', () => ({
  useHostedOperatorAccess: () => ({ hosted: true, allowed: state.operator }),
}));
vi.mock('@/components/providers/embed-provider', () => ({
  useEmbedding: () => ({ embedState: {} }),
}));
vi.mock('@/features/flows', () => ({ flowsApi: {} }));
vi.mock('@/features/folders', () => ({ foldersApi: {} }));
vi.mock('@/features/tables', () => ({ tablesApi: {} }));
vi.mock('@/features/projects', () => ({
  projectCollectionUtils: { useAll: () => ({ data: [] }) },
  getProjectName: vi.fn(),
}));
vi.mock('@/hooks/authorization-hooks', () => ({
  useIsPlatformAdmin: () => true,
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getProjectId: () => '' },
}));
vi.mock('@/app/components/global-search/access-history', () => ({
  getAccessHistory: () => state.history,
}));
vi.mock('@/app/components/global-search/static-pages', () => ({
  STATIC_PAGES: [
    { id: 'mcp', label: 'MCP', href: '/mcp-server' },
    {
      id: 'mcp-tools',
      label: 'MCP Tools',
      href: '/platform/mcp',
      requiresPlatformAdmin: true,
    },
    {
      id: 'configuration',
      label: 'Configurations',
      href: '/platform/configurations',
      requiresPlatformAdmin: true,
    },
    {
      id: 'workers',
      label: 'Workers',
      href: '/platform/workers',
      requiresPlatformAdmin: true,
    },
    {
      id: 'system',
      label: 'System Health',
      href: '/platform/health',
      requiresPlatformAdmin: true,
    },
    {
      id: 'runs',
      label: 'Runs Health',
      href: '/platform/health/runs',
      requiresPlatformAdmin: true,
    },
    {
      id: 'queue',
      label: 'Queue Health',
      href: '/platform/health/queue',
      requiresPlatformAdmin: true,
    },
  ],
}));
beforeEach(() => {
  state.operator = false;
  state.history = [];
});
function hrefs(query: string) {
  const { result } = renderHook(() => useGlobalSearchResults(query, true));
  return result.current.groups.flatMap((group) =>
    group.items.map((item) => item.href),
  );
}
describe('infrastructure visibility in global search', () => {
  it('omits infrastructure search matches for hosted tenant administrators', () => {
    expect(hrefs('Workers')).toEqual([]);
    expect(hrefs('MCP')).toEqual([]);
    expect(hrefs('Configurations')).toEqual([]);
    expect(hrefs('Health')).toEqual([
      '/platform/health/runs',
      '/platform/health/queue',
    ]);
  });
  it('removes stale infrastructure history entries while preserving workspace health', () => {
    state.history = [
      '/platform/workers',
      '/platform/infrastructure/health',
      '/platform/mcp/activity?limit=10',
      '/platform/configurations',
      '/platform/health/runs',
    ].map((href, index) => ({
      id: String(index),
      type: 'page',
      label: 'Previous visit',
      href,
      accessedAt: Date.now(),
    }));
    const visible = hrefs('');
    expect(visible).not.toContain('/platform/workers');
    expect(visible).not.toContain('/platform/mcp/activity?limit=10');
    expect(visible).not.toContain('/platform/configurations');
    expect(visible).not.toContain('/platform/infrastructure/health');
    expect(visible).toContain('/platform/health/runs');
  });
  it('retains infrastructure search results for the authorized hosted operator', () => {
    state.operator = true;
    expect(hrefs('Workers')).toEqual(['/platform/workers']);
    expect(hrefs('MCP')).toEqual(['/mcp-server', '/platform/mcp']);
    expect(hrefs('Configurations')).toEqual(['/platform/configurations']);
    expect(hrefs('Health')).toContain('/platform/health');
  });
});
