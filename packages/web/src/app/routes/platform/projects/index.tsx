import { ProjectType, ProjectWithLimits } from '@activepieces/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/react-table';
import { t } from 'i18next';
import { CheckIcon, Package, Pencil, Trash, UserCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import { projectsTableColumns } from './columns';

import { platformApi } from '@/api/platforms-api';
import { DashboardPageHeader } from '@/app/components/dashboard-page-header';
import {
  DataTable,
  RowDataWithActions,
  BulkAction,
} from '@/components/custom/data-table';
import { ConfirmationDeleteDialog } from '@/components/custom/delete-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { globalConnectionsQueries } from '@/features/connections';
import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import {
  CreateProjectButton,
  EditProjectDialog,
  projectCollectionUtils,
} from '@/features/projects';
import { PlatformAdminProjectAlertSubscriptionBulkActions } from '@/features/projects/components/platform-admin-project-alert-subscription-bulk-actions';
import { platformHooks } from '@/hooks/platform-hooks';
import { AdminControl, adminControl } from '@/lib/admin-control';
import { releaseAvailability } from '@/lib/release-availability';
import { validationUtils } from '@/lib/validation-utils';

export default function ProjectsPage() {
  const hosted = useHostedBillingEnabled();
  const { platform, setCurrentPlatform } = platformHooks.useCurrentPlatform();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { project: currentProject } =
    projectCollectionUtils.useCurrentProject();

  const displayNameFilter = searchParams.get('displayName') || undefined;
  const filters = useMemo(() => {
    const types = searchParams
      .getAll('type')
      .filter(
        (type): type is ProjectType =>
          type === ProjectType.PERSONAL || type === ProjectType.TEAM,
      );
    return {
      displayName: displayNameFilter,
      type: types.length > 0 ? types : undefined,
    };
  }, [displayNameFilter, searchParams]);

  const { data: allProjects } =
    projectCollectionUtils.useAllPlatformProjects(filters);

  const {
    mutate: toggleAutoCreatePersonalProjects,
    isPending: isAutoCreatePersonalProjectsPending,
  } = useMutation({
    mutationFn: (autoCreatePersonalProjects: boolean) =>
      platformApi.update({ autoCreatePersonalProjects }, platform.id),
    onSuccess: (updatedPlatform) => {
      setCurrentPlatform(queryClient, updatedPlatform);
      toast.success(t('Automatic personal project creation updated'), {
        duration: 3000,
      });
    },
    onError: () => {
      toast.error(t('Failed to save changes. Please try again.'));
    },
  });

  const [selectedRows, setSelectedRows] = useState<ProjectWithLimits[]>([]);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editDialogProjectId, setEditDialogProjectId] = useState<string>('');
  const editDialogProject = allProjects.find(
    (project) => project.id === editDialogProjectId,
  );
  const { data: allGlobalConnectionsPage } =
    globalConnectionsQueries.useGlobalConnections({
      request: { limit: 9999 },
      extraKeys: [],
    });
  const allProjectsWithGlobalConnectionsCount = useMemo(() => {
    return allProjects.map((project) => ({
      ...project,
      globalConnectionsCount:
        allGlobalConnectionsPage?.data?.filter((connection) =>
          connection.projectIds.includes(project.id),
        ).length ?? 0,
    }));
  }, [allProjects, allGlobalConnectionsPage?.data]);
  const columns = useMemo(
    () =>
      projectsTableColumns({
        platform,
      }),
    [platform],
  );

  const columnsWithCheckbox: ColumnDef<
    RowDataWithActions<ProjectWithLimits & { globalConnectionsCount: number }>
  >[] = [
    {
      id: 'select',
      accessorKey: 'select',
      size: 40,
      minSize: 40,
      maxSize: 40,
      header: ({ table }) => {
        const selectableRows = table
          .getRowModel()
          .rows.filter(
            (row) =>
              row.original.id !== currentProject?.id &&
              row.original.type === ProjectType.TEAM,
          );
        const allSelectableSelected =
          selectableRows.length > 0 &&
          selectableRows.every((row) => row.getIsSelected());
        const someSelectableSelected = selectableRows.some((row) =>
          row.getIsSelected(),
        );

        return (
          <Checkbox
            checked={allSelectableSelected || someSelectableSelected}
            onCheckedChange={(value) => {
              const isChecked = !!value;
              selectableRows.forEach((row) => row.toggleSelected(isChecked));

              if (isChecked) {
                const selectableProjects = selectableRows.map(
                  (row) => row.original,
                );
                const newSelectedRows = [
                  ...selectableProjects,
                  ...selectedRows,
                ];
                const uniqueRows = Array.from(
                  new Map(
                    newSelectedRows.map((item) => [item.id, item]),
                  ).values(),
                );
                setSelectedRows(uniqueRows);
              } else {
                const filteredRows = selectedRows.filter(
                  (row) =>
                    !selectableRows.some((r) => r.original.id === row.id),
                );
                setSelectedRows(filteredRows);
              }
            }}
          />
        );
      },
      cell: ({ row }) => {
        const isCurrentProject = row.original.id === currentProject?.id;
        const isDisabled =
          isCurrentProject || row.original.type === ProjectType.PERSONAL;
        const isChecked = selectedRows.some(
          (selectedRow) => selectedRow.id === row.original.id,
        );

        return (
          <Tooltip>
            <TooltipTrigger>
              <div className={isDisabled ? 'cursor-not-allowed' : ''}>
                <Checkbox
                  checked={isChecked}
                  disabled={isDisabled}
                  onCheckedChange={(value) => {
                    if (isDisabled) return;

                    const isChecked = !!value;
                    let newSelectedRows = [...selectedRows];
                    if (isChecked) {
                      const exists = newSelectedRows.some(
                        (selectedRow) => selectedRow.id === row.original.id,
                      );
                      if (!exists) {
                        newSelectedRows.push(row.original);
                      }
                    } else {
                      newSelectedRows = newSelectedRows.filter(
                        (selectedRow) => selectedRow.id !== row.original.id,
                      );
                    }
                    setSelectedRows(newSelectedRows);
                    row.toggleSelected(!!value);
                  }}
                />
              </div>
            </TooltipTrigger>
            {isDisabled && (
              <TooltipContent side="right">
                {isCurrentProject
                  ? t(
                      'Cannot delete active project, switch to another project first',
                    )
                  : t(
                      "Personal projects cannot be deleted, and you can't subscribe to their alerts",
                    )}
              </TooltipContent>
            )}
          </Tooltip>
        );
      },
    },
    ...columns,
  ];

  const bulkActions: BulkAction<ProjectWithLimits>[] = useMemo(
    () => [
      {
        render: (
          _: RowDataWithActions<ProjectWithLimits>[],
          resetSelection: () => void,
        ) =>
          releaseAvailability.projectAlerts ? (
            <PlatformAdminProjectAlertSubscriptionBulkActions
              selectedProjects={selectedRows}
              resetSelection={() => {
                resetSelection();
                setSelectedRows([]);
              }}
            />
          ) : null,
      },
      {
        render: (
          _: RowDataWithActions<ProjectWithLimits>[],
          resetSelection: () => void,
        ) => {
          const canDeleteAny = selectedRows.some(
            (row) =>
              row.id !== currentProject?.id && row.type === ProjectType.TEAM,
          );
          return (
            <div onClick={(e) => e.stopPropagation()}>
              <ConfirmationDeleteDialog
                title={t('Archive Command Centers')}
                message={t(
                  'The selected command centers will be archived. Their missions and data will be preserved.',
                )}
                entityName={t('Projects')}
                buttonText={t('Archive')}
                controlId={AdminControl.PROJECTS_DELETE_CONFIRM}
                mutationFn={async () => {
                  const deletableProjects = selectedRows.filter(
                    (row) =>
                      row.id !== currentProject?.id &&
                      row.type === ProjectType.TEAM,
                  );
                  const transaction = projectCollectionUtils.delete(
                    deletableProjects.map((row) => row.id),
                  );
                  try {
                    await transaction.isPersisted.promise;
                  } finally {
                    await projectCollectionUtils.refetchProjects();
                    resetSelection();
                    setSelectedRows([]);
                  }
                }}
                onError={(error) => {
                  toast.error(t('Error'), {
                    description: errorToastMessage(error),
                    duration: 3000,
                  });
                }}
              >
                {selectedRows.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger-11 hover:text-danger-11"
                    disabled={!canDeleteAny}
                    {...adminControl(AdminControl.PROJECTS_DELETE_OPEN)}
                  >
                    <Trash className="mr-1 w-4" />
                    {`${t('Archive')} (${selectedRows.length})`}
                  </Button>
                )}
              </ConfirmationDeleteDialog>
            </div>
          );
        },
      },
    ],
    [selectedRows, currentProject],
  );

  const toolbarButtons = useMemo(
    () => [
      <CreateProjectButton
        key="new-project"
        variant="full"
        projects={allProjects}
      />,
    ],
    [allProjects],
  );

  const errorToastMessage = (error: unknown): string | undefined => {
    if (validationUtils.isValidationError(error)) {
      console.error(t('Validation error'), error);
      switch (error.response?.data?.params?.message) {
        case 'PROJECT_HAS_ENABLED_FLOWS':
          return t('Project has enabled flows. Please disable them first.');
        case 'PROJECT_HAS_UNFINISHED_RUNS':
          return t(
            'Wait for queued, running or paused missions to finish before archiving this command center.',
          );
        case 'PERSONAL_PROJECT':
          return t('Your Personal Command Center cannot be archived.');
        case 'ACTIVE_PROJECT':
          return t(
            'This project is active. Please switch to another project first.',
          );
      }
      return undefined;
    }
  };

  const actions = [
    (row: ProjectWithLimits) => {
      if (row.type === ProjectType.PERSONAL) return null;
      return (
        <div className="flex items-end justify-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                className="size-8 p-0"
                aria-label={t('Edit project')}
                {...adminControl(AdminControl.PROJECTS_EDIT_OPEN)}
                onClick={async (e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setEditDialogProjectId(row.id);
                  setEditDialogOpen(true);
                }}
              >
                <Pencil className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('Edit project')}</TooltipContent>
          </Tooltip>
        </div>
      );
    },
  ];

  return (
    <div className="flex flex-col w-full">
      <DashboardPageHeader
        title={t('Projects')}
        description={
          hosted
            ? t(
                'One Command Center, shared by everyone in this client account.',
              )
            : t('Manage your automation projects')
        }
      />
      {releaseAvailability.projectProvisioning && (
        <div className="px-6 pt-4">
          <Item variant="outline">
            <ItemMedia variant="icon">
              <UserCircle />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t('Automatic personal project creation')}</ItemTitle>
              <ItemDescription>
                {t(
                  'Create a personal project for every new user on signup. Turn off if you provision users into team projects manually (e.g. via SSO or SCIM).',
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                checked={platform.autoCreatePersonalProjects}
                onCheckedChange={(checked) =>
                  toggleAutoCreatePersonalProjects(checked)
                }
                disabled={isAutoCreatePersonalProjectsPending}
                {...adminControl(AdminControl.PROJECTS_AUTO_PERSONAL_TOGGLE)}
              />
            </ItemActions>
          </Item>
        </div>
      )}
      <DataTable
        emptyStateTextTitle={t('No projects found')}
        emptyStateTextDescription={t(
          'Create a command center to organize your missions, connected accounts and data.',
        )}
        emptyStateIcon={<Package className="size-14" />}
        onRowClick={async (project) => {
          await projectCollectionUtils.setCurrentProject(project.id);
          navigate('/');
        }}
        filters={[
          {
            type: 'input',
            title: t('Name'),
            accessorKey: 'displayName',
            icon: CheckIcon,
          },
          {
            type: 'select',
            title: t('Type'),
            accessorKey: 'type',
            options: [ProjectType.PERSONAL, ProjectType.TEAM].map((type) => {
              return {
                label: t(
                  type === ProjectType.PERSONAL
                    ? 'Personal Project'
                    : 'Team Project',
                ),
                value: type,
              };
            }),
            icon: CheckIcon,
          },
        ]}
        columns={
          releaseAvailability.projectAdministration
            ? columnsWithCheckbox
            : columns
        }
        page={{
          data: allProjectsWithGlobalConnectionsCount,
          next: null,
          previous: null,
        }}
        isLoading={false}
        isError={false}
        errorStateEntity={t('projects')}
        clientPagination={true}
        bulkActions={
          releaseAvailability.projectAdministration && !hosted
            ? bulkActions
            : []
        }
        toolbarButtons={toolbarButtons}
        actions={releaseAvailability.projectAdministration ? actions : []}
      />
      <EditProjectDialog
        open={editDialogOpen}
        onClose={() => {
          setEditDialogOpen(false);
        }}
        initialValues={
          editDialogProject && {
            projectName: editDialogProject.displayName,
            externalId: editDialogProject.externalId ?? undefined,
            sensitive: editDialogProject.sensitive,
          }
        }
        projectId={editDialogProjectId}
      />
    </div>
  );
}
