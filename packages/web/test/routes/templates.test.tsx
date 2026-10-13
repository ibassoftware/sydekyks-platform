import { Template, TemplateStatus, TemplateType } from '@activepieces/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TemplatesPage } from '@/app/routes/templates';

const state = vi.hoisted(() => {
  const data: GalleryState = {
    templates: [],
    officialTemplates: [],
    categories: undefined,
    search: '',
    category: 'All',
    isError: false,
    allError: false,
    isLoading: false,
  };
  return { ...data, refetch: vi.fn() };
});

vi.mock('i18next', () => ({
  t: (key: string, values?: { entity: string }) =>
    key.replace('{entity}', values?.entity ?? ''),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/hooks/platform-hooks', () => ({
  platformHooks: {
    useCurrentPlatform: () => ({
      platform: { plan: { manageTemplatesEnabled: false } },
    }),
  },
}));
vi.mock('@/features/flows', () => ({
  flowHooks: {
    useStartFromScratch: () => ({ mutate: vi.fn(), isPending: false }),
  },
}));
vi.mock('@/features/templates', () => ({
  templatesTelemetryApi: { sendEvent: vi.fn() },
  templatesHooks: {
    useTemplateCategories: () => ({ data: state.categories }),
    useTemplates: () => ({
      templates: state.templates,
      search: state.search,
      category: state.category,
      isLoading: state.isLoading,
      isError: state.isError,
      refetch: state.refetch,
      setSearch: vi.fn(),
      setCategory: vi.fn(),
    }),
    useAllOfficialTemplates: () => ({
      data: state.officialTemplates,
      isLoading: false,
      isError: state.allError,
      refetch: state.refetch,
    }),
  },
}));
vi.mock('@/components/custom/page-header', () => ({
  PageHeader: () => <header />,
}));
vi.mock('@/app/routes/templates/category-filter-carousel', () => ({
  CategoryFilterCarousel: ({ categories }: { categories: string[] }) => (
    <nav>{categories.join(',')}</nav>
  ),
}));
vi.mock('@/app/routes/templates/all-categories-view', () => ({
  AllCategoriesView: () => <div>Grouped catalog</div>,
}));
vi.mock('@/app/routes/templates/selected-category-view', () => ({
  SelectedCategoryView: ({ templates }: { templates: Template[] }) => (
    <div>{templates.map((template) => template.name).join(',')}</div>
  ),
}));

function template(name: string): Template {
  return {
    id: name,
    created: '',
    updated: '',
    name,
    type: TemplateType.OFFICIAL,
    summary: '',
    description: '',
    tags: [],
    blogUrl: null,
    metadata: null,
    author: '',
    categories: ['Engineering'],
    pieces: [],
    platformId: null,
    status: TemplateStatus.PUBLISHED,
  };
}

beforeEach(() => {
  state.templates = [];
  state.officialTemplates = [];
  state.categories = undefined;
  state.search = '';
  state.category = 'All';
  state.isError = false;
  state.allError = false;
  state.isLoading = false;
});

describe('mission template gallery', () => {
  it('shows a retryable failure instead of an empty catalog after a failed request', () => {
    state.isError = true;
    const html = renderToStaticMarkup(<TemplatesPage />);
    expect(html).toContain('Trouble loading templates');
    expect(html).toContain('Try again');
    expect(html).not.toContain('No templates found');
  });

  it('reports a failed grouped-catalog request', () => {
    state.templates = [template('Visible mission')];
    state.allError = true;
    expect(renderToStaticMarkup(<TemplatesPage />)).toContain(
      'Trouble loading templates'
    );
  });

  it('shows the empty state only when the request succeeds without matches', () => {
    const html = renderToStaticMarkup(<TemplatesPage />);
    expect(html).toContain('No templates found');
    expect(html).not.toContain('Trouble loading');
  });

  it('shows search results rather than the cached full catalog', () => {
    state.search = 'Webhook';
    state.templates = [template('Webhook mission')];
    state.officialTemplates = [template('Unrelated mission')];
    const html = renderToStaticMarkup(<TemplatesPage />);
    expect(html).toContain('Webhook mission');
    expect(html).not.toContain('Grouped catalog');
    expect(html).not.toContain('Unrelated mission');
  });

  it('uses filtered results for a selected category and search', () => {
    state.category = 'Engineering';
    state.search = 'Webhook';
    state.templates = [template('Webhook mission')];
    state.officialTemplates = [template('Unrelated mission')];
    const html = renderToStaticMarkup(<TemplatesPage />);
    expect(html).toContain('Webhook mission');
    expect(html).not.toContain('Unrelated mission');
  });

  it('derives categories from the catalog when category metadata is unavailable', () => {
    state.templates = [template('Webhook mission')];
    state.officialTemplates = state.templates;
    expect(renderToStaticMarkup(<TemplatesPage />)).toContain(
      'All,Engineering'
    );
  });
});

type GalleryState = {
  templates: Template[];
  officialTemplates: Template[];
  categories: string[] | undefined;
  search: string;
  category: string;
  isError: boolean;
  allError: boolean;
  isLoading: boolean;
};
