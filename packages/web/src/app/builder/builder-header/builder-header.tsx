import { Permission } from '@activepieces/core-utils';
import {
  FlowOperationType,
  FlowVersionState,
  UncategorizedFolderId,
} from '@activepieces/shared';
import { useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { ChevronDown, HistoryIcon, MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  createSearchParams,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';

import { useBuilderStateContext } from '@/app/builder/builder-hooks';
import { RightSideBarType } from '@/app/builder/types';
import { ActiveUsersWidget } from '@/components/custom/active-users-widget';
import EditableText from '@/components/custom/editable-text';
import { HomeButton } from '@/components/custom/home-button';
import { PageHeader } from '@/components/custom/page-header';
import { useEmbedding } from '@/components/providers/embed-provider';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { flowHooks } from '@/features/flows';
import { FlowCreatedByBadge } from '@/features/flows/components/flow-created-by-badge';
import { foldersHooks } from '@/features/folders';
import {
  projectSelectionLabel,
  projectCollectionUtils,
} from '@/features/projects';
import { useAuthorization } from '@/hooks/authorization-hooks';
import { platformHooks } from '@/hooks/platform-hooks';
import { authenticationSession } from '@/lib/authentication-session';
import { NEW_FLOW_QUERY_PARAM } from '@/lib/route-utils';
import { cn } from '@/lib/utils';

import FlowActionMenu from '../../components/flow-actions-menu';
import { flowCanvasConsts } from '../flow-canvas/utils/consts';

import { BuilderFlowStatusSection } from './flow-status';

export const BuilderHeader = ({
  copilotOpen,
  onToggleCopilot,
}: { copilotOpen?: boolean; onToggleCopilot?: () => void } = {}) => {
  const [queryParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const hasPermissionToReadRuns = useAuthorization().checkAccess(
    Permission.READ_FLOW,
  );
  const [
    flow,
    flowVersion,
    moveToFolderClientSide,
    applyOperation,
    setRightSidebar,
    savePendingEdits,
  ] = useBuilderStateContext((state) => [
    state.flow,
    state.flowVersion,
    state.moveToFolderClientSide,
    state.applyOperation,
    state.setRightSidebar,
    state.savePendingEdits,
  ]);

  const { embedState } = useEmbedding();
  const { project } = projectCollectionUtils.useCurrentProject();
  const { data: projects } = projectCollectionUtils.useAll();
  const { platform } = platformHooks.useCurrentPlatform();

  const { data: folderData } = foldersHooks.useFolder(
    flow.folderId ?? UncategorizedFolderId,
  );

  const isLatestVersion =
    flowVersion.state === FlowVersionState.DRAFT ||
    flowVersion.id === flow.publishedVersionId;
  const [isEditingFlowName, setIsEditingFlowName] = useState(false);
  useEffect(() => {
    setIsEditingFlowName(queryParams.get(NEW_FLOW_QUERY_PARAM) === 'true');
  }, []);

  const goToFlowsPage = () => {
    navigate({
      pathname: authenticationSession.appendProjectRoutePrefix('/automations'),
      search: createSearchParams({
        folderId: folderData?.id ?? UncategorizedFolderId,
      }).toString(),
    });
  };

  const titleContent = (
    <div className="flex min-w-0 items-center gap-2 px-0 sm:px-4">
      <Breadcrumb>
        <BreadcrumbList>
          {!embedState.disableNavigationInBuilder && (
            <>
              <BreadcrumbItem className="hidden md:flex">
                <BreadcrumbLink
                  onClick={goToFlowsPage}
                  className="flex min-w-0 max-w-64 cursor-pointer flex-col items-start text-sm"
                  title={`${platform.name} · ${projectSelectionLabel(
                    project,
                    projects,
                  )}`}
                >
                  <span className="block max-w-full truncate text-xs text-gray-11">
                    {platform.name}
                  </span>
                  <span className="block max-w-full truncate">
                    {projectSelectionLabel(project, projects)}
                  </span>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
            </>
          )}
          {!embedState.hideFlowNameInBuilder && (
            <BreadcrumbItem>
              <BreadcrumbPage>
                <div
                  className={cn('flex items-center gap-1 text-sm', {
                    'max-w-[110px] sm:max-w-[300px] xl:max-w-[500px]':
                      !isEditingFlowName,
                  })}
                >
                  <EditableText
                    className="hover:cursor-text"
                    value={flowVersion.displayName}
                    readonly={!isLatestVersion}
                    onValueChange={(value) => {
                      applyOperation(
                        {
                          type: FlowOperationType.CHANGE_NAME,
                          request: {
                            displayName: value,
                          },
                        },
                        () => {
                          flowHooks.invalidateFlowsQuery(queryClient);
                        },
                      );
                    }}
                    isEditing={isEditingFlowName}
                    setIsEditing={setIsEditingFlowName}
                    tooltipContent=""
                  />
                  <FlowActionMenu
                    onVersionsListClick={() => {
                      setRightSidebar(RightSideBarType.VERSIONS);
                    }}
                    insideBuilder={true}
                    savePendingEdits={savePendingEdits}
                    flow={flow}
                    flowVersion={flowVersion}
                    readonly={!isLatestVersion}
                    onDelete={goToFlowsPage}
                    onRename={() => {
                      setIsEditingFlowName(true);
                    }}
                    onMoveTo={(folderId) => moveToFolderClientSide(folderId)}
                    onDuplicate={() => {}}
                  >
                    <Button
                      variant="ghost"
                      className="size-6 flex items-center justify-center"
                    >
                      <ChevronDown className="h-4 w-4 text-gray-11" />
                    </Button>
                  </FlowActionMenu>
                </div>
              </BreadcrumbPage>
            </BreadcrumbItem>
          )}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );

  const rightContent = (
    <div className="flex shrink-0 items-center justify-center gap-1 sm:gap-4">
      {onToggleCopilot && (
        <Button
          variant="ghost"
          aria-label={t('Ask Syd')}
          aria-pressed={copilotOpen}
          onClick={onToggleCopilot}
          className="gap-2 px-2"
        >
          <MessageSquare className="size-4" />
          <span className="hidden sm:inline">{t('Ask Syd')}</span>
        </Button>
      )}
      {!embedState.hideActiveUsers && (
        <ActiveUsersWidget resourceId={flow.id} />
      )}
      {hasPermissionToReadRuns && (
        <Button
          variant="ghost"
          aria-label={t('Run history')}
          onClick={() => setRightSidebar(RightSideBarType.RUNS)}
          className="gap-2 px-2"
        >
          <HistoryIcon className="w-4 h-4" />
          <span className="hidden sm:inline">{t('Run history')}</span>
        </Button>
      )}

      <BuilderFlowStatusSection></BuilderFlowStatusSection>
      <FlowCreatedByBadge createdBy={flow.createdBy} />
    </div>
  );

  const leftContent = embedState.isEmbedded ? <HomeButton /> : null;

  return (
    <div
      style={{
        height: `${flowCanvasConsts.BUILDER_HEADER_HEIGHT}px`,
      }}
    >
      <PageHeader
        title={titleContent}
        rightContent={rightContent}
        leftContent={leftContent}
        className="select-none border-b"
      />
    </div>
  );
};
