import {
  Template,
  TemplateTelemetryEventType,
  TemplateType,
  UncategorizedFolderId,
} from '@activepieces/shared';
import { t } from 'i18next';
import { Plus } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { DataFetchErrorState } from '@/components/custom/data-fetch-error-state';
import { PageHeader } from '@/components/custom/page-header';
import { SearchInput } from '@/components/custom/search-input';
import { Button } from '@/components/ui/button';
import { flowHooks } from '@/features/flows';
import { templatesTelemetryApi, templatesHooks } from '@/features/templates';
import { platformHooks } from '@/hooks/platform-hooks';
import { DASHBOARD_CONTENT_PADDING_X } from '@/lib/utils';

import { AllCategoriesView } from './all-categories-view';
import { CategoryFilterCarousel } from './category-filter-carousel';
import { EmptyTemplatesView } from './empty-templates-view';
import { SelectedCategoryView } from './selected-category-view';

const TemplatesPage = () => {
  const navigate = useNavigate();
  const { data: templateCategories } = templatesHooks.useTemplateCategories();
  const { platform } = platformHooks.useCurrentPlatform();
  const isShowingOfficialTemplates = !platform.plan.manageTemplatesEnabled;
  const {
    templates,
    isLoading,
    isError,
    refetch,
    search,
    setSearch,
    category,
    setCategory,
  } = templatesHooks.useTemplates(
    isShowingOfficialTemplates ? TemplateType.OFFICIAL : TemplateType.CUSTOM,
  );
  const selectedCategory = category;
  const {
    data: allOfficialTemplates,
    isLoading: isAllTemplatesLoading,
    isError: isAllTemplatesError,
    refetch: refetchAllTemplates,
  } = templatesHooks.useAllOfficialTemplates();
  const { mutate: createFlow, isPending: isCreateFlowPending } =
    flowHooks.useStartFromScratch(UncategorizedFolderId);

  const handleSearchChange = (value: string) => {
    setSearch(value);
  };

  const handleTemplateSelect = useCallback(
    (template: Template) => {
      navigate(`/templates/${template.id}`);
      if (template.type === TemplateType.OFFICIAL) {
        templatesTelemetryApi.sendEvent({
          eventType: TemplateTelemetryEventType.VIEW,
          templateId: template.id,
        });
      }
    },
    [navigate],
  );

  const templatesByCategory = useMemo(() => {
    const grouped: Record<string, Template[]> = {};

    if (isShowingOfficialTemplates) {
      allOfficialTemplates?.forEach((template: Template) => {
        if (template.categories?.length) {
          template.categories?.forEach((category: string) => {
            if (!grouped[category]) {
              grouped[category] = [];
            }
            grouped[category].push(template);
          });
        }
      });
    }

    return grouped;
  }, [allOfficialTemplates, isShowingOfficialTemplates]);

  const categories = useMemo(() => {
    return ['All', ...(templateCategories ?? Object.keys(templatesByCategory))];
  }, [templateCategories, templatesByCategory]);

  const selectedCategoryTemplates = useMemo(() => {
    return templates || [];
  }, [templates]);

  const showAllCategories =
    isShowingOfficialTemplates && selectedCategory === 'All' && !search.trim();
  const showLoading = isLoading || (showAllCategories && isAllTemplatesLoading);
  const hasTemplates = templates && templates.length > 0;
  const showCategoryTitleForOfficialTemplates =
    isShowingOfficialTemplates && selectedCategory !== 'All';

  return (
    <div>
      <div>
        <div className="sticky top-0 z-10 bg-gray-1">
          <PageHeader
            className="static"
            title={
              <>
                <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-between">
                  <SearchInput
                    value={search}
                    onChange={handleSearchChange}
                    placeholder={t('Search templates by name or description')}
                  ></SearchInput>
                  <div className="flex shrink-0 justify-end">
                    <Button
                      variant="outline"
                      className="gap-2 h-full"
                      onClick={() => createFlow()}
                      disabled={isCreateFlowPending}
                    >
                      <Plus className="w-4 h-4" />
                      {t('Start from scratch')}
                    </Button>
                  </div>
                </div>
              </>
            }
          ></PageHeader>

          {isShowingOfficialTemplates && categories && (
            <CategoryFilterCarousel
              categories={categories}
              selectedCategory={selectedCategory}
              onCategorySelect={setCategory}
            />
          )}
        </div>
        <div className={DASHBOARD_CONTENT_PADDING_X}>
          {isError || (showAllCategories && isAllTemplatesError) ? (
            <DataFetchErrorState
              entity={t('templates')}
              onRetry={() => Promise.all([refetch(), refetchAllTemplates()])}
            />
          ) : !hasTemplates && !showLoading ? (
            <EmptyTemplatesView />
          ) : showAllCategories ? (
            <AllCategoriesView
              templatesByCategory={templatesByCategory}
              categories={categories}
              onCategorySelect={setCategory}
              onTemplateSelect={handleTemplateSelect}
              isLoading={showLoading}
              hideHeader={!isShowingOfficialTemplates}
            />
          ) : (
            <SelectedCategoryView
              category={selectedCategory}
              templates={selectedCategoryTemplates}
              onTemplateSelect={handleTemplateSelect}
              isLoading={showLoading}
              showCategoryTitle={showCategoryTitleForOfficialTemplates}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export { TemplatesPage };
