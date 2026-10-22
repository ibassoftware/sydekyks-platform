import {
  ApEdition,
  ApFlagId,
  isNil,
  PlatformRole,
  PROJECT_COLOR_PALETTE,
  ProjectType,
  ProjectWithLimits,
  TemplateTelemetryEventType,
} from '@activepieces/shared';
import { useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import {
  Bot,
  BriefcaseBusiness,
  ChartLine,
  ChevronsUpDown,
  Compass,
  GraduationCap,
  MessageCircle,
  Radar,
  LogOut,
  PanelLeftClose,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Unplug,
  UserCogIcon,
  Users,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { ComponentType, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { TextWithTooltip } from '@/components/custom/text-with-tooltip';
import { UserAvatar } from '@/components/custom/user-avatar';
import { useEmbedding } from '@/components/providers/embed-provider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useAgentsNavVisible } from '@/features/agents';
import { SidebarUsageLimits } from '@/features/billing';
import { chatUtils } from '@/features/chat/lib/chat-utils';
import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import { useHostedOperatorAccess } from '@/features/hosted-operator/operator-api';
import { usePlatformTrainerAccess } from '@/features/hosted-operator/trainers-api';
import { useOperationalWorkspaces } from '@/features/hosted-operator/workspaces-api';
import {
  CreateProjectButton,
  getProjectName,
  projectReference,
  PlatformSwitcher,
  projectCollectionUtils,
} from '@/features/projects';
import { templatesTelemetryApi } from '@/features/templates';
import {
  railIsCollapsed,
  useRailCollapsed,
} from '@/features/workspace/lib/rail-collapsed';
import { useIsPlatformAdmin } from '@/hooks/authorization-hooks';
import { flagsHooks } from '@/hooks/flags-hooks';
import { platformHooks } from '@/hooks/platform-hooks';
import { useIsMobile } from '@/hooks/use-mobile';
import { userHooks } from '@/hooks/user-hooks';
import { authenticationSession } from '@/lib/authentication-session';
import { releaseAvailability } from '@/lib/release-availability';
import { sydekyksBrand } from '@/lib/sydekyks-brand';
import { cn } from '@/lib/utils';

import { AccountSettingsDialog } from '../account-settings';
import { recordAccess } from '../global-search/access-history';
import { useGlobalSearch } from '../global-search/global-search-context';
import { mcpHooks } from '../project-settings/mcp-server/utils/mcp-hooks';

export function PrimaryRail() {
  const branding = flagsHooks.useWebsiteBranding();
  const { embedState } = useEmbedding();
  const { platform } = platformHooks.useCurrentPlatform();
  const { data: currentUser } = userHooks.useCurrentUser();
  const { preference, setCollapsed, toggle } = useRailCollapsed();
  const { pathname } = useLocation();
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const collapsed = isMobile
    ? !mobileExpanded
    : railIsCollapsed({ preference, pathname, openedOn });
  const showAgents = useAgentsNavVisible();
  const hostedBilling = useHostedBillingEnabled();
  const isRailHidden = embedState.isEmbedded || embedState.hideSideNav;
  const { reachesMcp } = mcpHooks.useMcpReach({
    enabled: !isRailHidden && !hostedBilling,
  });

  if (isRailHidden) {
    return null;
  }

  const openSidebar = () => {
    if (isMobile) {
      setMobileExpanded(true);
      return;
    }
    setOpenedOn(pathname);
    setCollapsed(false);
  };
  const toggleCollapsed = () => {
    if (isMobile) {
      setMobileExpanded((expanded) => !expanded);
      return;
    }
    setOpenedOn(pathname);
    toggle();
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div
        onClick={collapsed ? openSidebar : undefined}
        title={collapsed ? t('Open sidebar') : undefined}
        className={cn(
          'flex h-svh shrink-0 flex-col overflow-hidden whitespace-nowrap bg-gray-2 py-3 transition-[width] duration-200 motion-reduce:transition-none',
          collapsed ? 'w-14 cursor-ew-resize items-center' : 'w-62',
          isMobile && !collapsed && 'absolute inset-y-0 left-0 z-50 shadow-lg',
        )}
      >
        <RailHeader collapsed={collapsed} onToggle={toggleCollapsed} />

        <div
          className={cn(
            'mt-2 flex min-h-0 flex-1 flex-col',
            collapsed ? 'items-center px-2' : 'px-2',
          )}
        >
          <div
            className={cn(
              'flex shrink-0 flex-col gap-1',
              collapsed && 'items-center',
            )}
          >
            {platform.plan.chatEnabled && (
              <RailNavButton
                collapsed={collapsed}
                to="/chat"
                icon={
                  branding.logos.fullLogoUrl === sydekyksBrand.logos.fullLogoUrl
                    ? SydNavIcon
                    : MessageCircle
                }
                label={t('Chat')}
                isActive={({ pathname }) => pathname.startsWith('/chat')}
                onClick={() =>
                  window.dispatchEvent(new Event(chatUtils.newChatEvent))
                }
              />
            )}
            {!hostedBilling && reachesMcp && (
              <RailNavButton
                collapsed={collapsed}
                to="/mcp-server"
                icon={Unplug}
                label={t('MCP')}
                isActive={({ pathname }) => pathname.startsWith('/mcp-server')}
              />
            )}
            {showAgents && (
              <RailNavButton
                collapsed={collapsed}
                to="/agents"
                icon={Bot}
                label={t('Agents')}
                isActive={({ pathname }) => pathname.startsWith('/agents')}
              />
            )}
            <RailNavButton
              collapsed={collapsed}
              to="/templates"
              icon={Compass}
              label={t('Templates')}
              isActive={({ pathname }) => pathname.startsWith('/templates')}
              onClick={() =>
                templatesTelemetryApi.sendEvent({
                  eventType: TemplateTelemetryEventType.EXPLORE_VIEW,
                  userId: currentUser?.id,
                })
              }
            />
            {platform.plan.analyticsEnabled &&
              releaseAvailability.isRouteAvailable({ pathname: '/impact' }) && (
                <RailNavButton
                  collapsed={collapsed}
                  to="/impact"
                  icon={ChartLine}
                  label={t('Impact')}
                  isActive={({ pathname }) => pathname.startsWith('/impact')}
                />
              )}
          </div>
          <RailPinnedProjects collapsed={collapsed} />
        </div>

        {!collapsed && (
          <div className="mx-2 mb-1">
            <SidebarUsageLimits />
          </div>
        )}
        <RailPlatformAdminButton collapsed={collapsed} />
        <RailAccountRow collapsed={collapsed} />
      </div>
    </TooltipProvider>
  );
}

function RailHeader({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const branding = flagsHooks.useWebsiteBranding();
  const { setOpen: setSearchOpen } = useGlobalSearch();
  const { embedState } = useEmbedding();
  const { data: edition } = flagsHooks.useFlag<ApEdition>(ApFlagId.EDITION);
  const { platform: currentPlatform } = platformHooks.useCurrentPlatform();
  const showSwitcher = edition === ApEdition.CLOUD && !embedState.isEmbedded;

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggle}
              aria-label={t('Open sidebar')}
              className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-gray-4"
            >
              <img
                src={branding.logos.logoIconUrl}
                alt={branding.websiteName}
                className="size-5 shrink-0"
                draggable={false}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('Open sidebar')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSearchOpen(true);
              }}
              aria-label={t('Search')}
              className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-11 hover:bg-gray-4 hover:text-gray-12"
            >
              <Search className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('Search')}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 px-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/"
            className="flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-gray-4"
          >
            <img
              src={branding.logos.logoIconUrl}
              alt={branding.websiteName}
              className="size-5 shrink-0"
              draggable={false}
            />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">{branding.websiteName}</TooltipContent>
      </Tooltip>

      {showSwitcher ? (
        <div className="min-w-0 flex-1">
          <PlatformSwitcher>
            <button
              type="button"
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-gray-4"
            >
              <span className="flex-1 truncate text-sm font-medium">
                {currentPlatform?.name ?? t('platform')}
              </span>
              <ChevronsUpDown className="ml-auto size-3 shrink-0" />
            </button>
          </PlatformSwitcher>
        </div>
      ) : (
        <h1
          className={cn(
            'min-w-0 flex-1 truncate text-sm font-medium',
            branding.logos.fullLogoUrl === sydekyksBrand.logos.fullLogoUrl &&
              'sydekyks-wordmark text-lg',
          )}
        >
          {branding.logos.fullLogoUrl === sydekyksBrand.logos.fullLogoUrl
            ? branding.websiteName.toLowerCase()
            : branding.websiteName}
        </h1>
      )}

      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 rounded-full text-gray-11 hover:bg-gray-4 hover:text-gray-12"
              onClick={() => setSearchOpen(true)}
              aria-label={t('Search')}
            >
              <Search className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('Search')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 rounded-full text-gray-11 hover:bg-gray-4 hover:text-gray-12"
              onClick={onToggle}
              aria-label={t('Close sidebar')}
            >
              <PanelLeftClose className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('Close sidebar')}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function RailPlatformAdminButton({ collapsed }: { collapsed: boolean }) {
  const showPlatformAdmin = useIsPlatformAdmin();
  const hosted = useHostedBillingEnabled();
  const operator = useHostedOperatorAccess();
  const { embedState } = useEmbedding();

  if (embedState.isEmbedded || !showPlatformAdmin) {
    return null;
  }

  return (
    <div className={cn('flex flex-col px-2 pb-1', collapsed && 'items-center')}>
      <div
        className={cn(
          'mb-1 h-px shrink-0 bg-gray-6',
          collapsed ? 'w-6' : 'mx-3',
        )}
      />
      <RailNavButton
        collapsed={collapsed}
        to="/platform/projects"
        icon={Shield}
        label={
          hosted && !operator.allowed
            ? t('Workspace settings')
            : t('Platform Admin')
        }
        isActive={({ pathname }) => pathname.startsWith('/platform')}
      />
    </div>
  );
}

function SydNavIcon({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center justify-center', className)}>
      <img
        src={sydekyksBrand.companionUrl}
        alt=""
        width={32}
        height={32}
        draggable={false}
        className="size-8 max-w-none shrink-0 object-contain"
      />
    </span>
  );
}

function RailNavButton({
  collapsed,
  to,
  icon: Icon,
  label,
  isActive,
  onClick,
}: {
  collapsed: boolean;
  to: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  isActive: (location: { pathname: string; search: string }) => boolean;
  onClick?: () => void;
}) {
  const location = useLocation();
  const active = isActive(location);

  const link = (
    <Link
      to={to}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className={cn(
        'flex shrink-0 items-center gap-3 rounded-full text-sm text-gray-12 hover:bg-gray-4 hover:text-gray-12',
        collapsed ? 'size-9 cursor-pointer justify-center' : 'h-10 px-3',
        active && 'bg-accent-3 font-medium text-accent-12',
      )}
    >
      <Icon className={cn('size-4.5 shrink-0', active && 'text-accent-11')} />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );

  if (!collapsed) {
    return link;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function RailPinnedProjects({ collapsed }: { collapsed: boolean }) {
  const hostedBilling = useHostedBillingEnabled();
  const { data: projects } = projectCollectionUtils.useAll();
  const { platform } = platformHooks.useCurrentPlatform();
  const { data: currentUser } = userHooks.useCurrentUser();
  const location = useLocation();
  const navigate = useNavigate();
  const showCreateProject =
    releaseAvailability.isTeamProjectCreationAvailable({ hostedBilling }) &&
    platform.plan.billedTeamProjectsLimit !== 0 &&
    currentUser?.platformRole === PlatformRole.ADMIN;
  const [sort, setSort] = useState<PinnedSort>(() =>
    readStoredSort(localStorage.getItem(PINNED_SORT_KEY)),
  );

  const changeSort = (next: PinnedSort) => {
    setSort(next);
    localStorage.setItem(PINNED_SORT_KEY, next);
  };

  if (projects.length === 0) {
    return null;
  }

  const ordered = orderProjects({
    projects,
    sort,
  });

  const openProject = ({
    projectId,
    name,
  }: {
    projectId: string;
    name: string;
  }) => {
    recordAccess({
      id: `project-${projectId}`,
      type: 'project',
      label: name,
      href: `/projects/${projectId}/automations`,
    });
    if (projectId !== authenticationSession.getProjectId()) {
      authenticationSession.switchToProject(projectId);
    }
    navigate(`/projects/${projectId}/automations`);
  };

  return (
    <div
      className={cn(
        'mt-2 flex min-h-0 flex-1 flex-col',
        collapsed && 'items-center',
      )}
    >
      <div
        className={cn(
          'mb-1 h-px shrink-0 bg-gray-6',
          collapsed ? 'w-6' : 'mx-3',
        )}
      />
      {!collapsed && (
        <div className="flex shrink-0 items-center gap-1 py-0.5 pl-3 pr-1">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-11">
            {t('Projects')}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            {showCreateProject && (
              <CreateProjectButton
                variant="icon"
                projects={projects ?? []}
                className={RAIL_HEADER_ICON_BUTTON}
                onCreate={(project) => {
                  navigate(`/projects/${project.id}/automations`);
                }}
              />
            )}
            <PinnedSortMenu sort={sort} onChange={changeSort} />
          </div>
        </div>
      )}
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto',
          collapsed && 'items-center',
        )}
      >
        {ordered.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            workspaceName={platform.name}
            ownershipLabel={
              project.ownerId === currentUser?.id
                ? t('Your project')
                : t('Shared project')
            }
            reference={projectReference(project, ordered)}
            collapsed={collapsed}
            active={location.pathname.includes(`/projects/${project.id}`)}
            onOpen={openProject}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectRow({
  project,
  workspaceName,
  ownershipLabel,
  reference,
  collapsed,
  active,
  onOpen,
}: {
  project: ProjectWithLimits;
  workspaceName: string;
  ownershipLabel: string;
  reference: string | null;
  collapsed: boolean;
  active: boolean;
  onOpen: (params: { projectId: string; name: string }) => void;
}) {
  const prefersReducedMotion = useReducedMotion();
  const name = getProjectName(project);
  const context = [
    reference && `${t('Reference')} ${reference}`,
    ownershipLabel,
    workspaceName,
  ]
    .filter(Boolean)
    .join(' · ');
  const isTeam = project.type === ProjectType.TEAM;
  const palette =
    isTeam && project.icon ? PROJECT_COLOR_PALETTE[project.icon.color] : null;

  const badge = (
    <span
      className="flex size-[18px] shrink-0 items-center justify-center rounded-[4px] text-[10px] font-bold leading-none"
      style={
        palette
          ? { backgroundColor: palette.color, color: palette.textColor }
          : undefined
      }
    >
      {isTeam ? (
        name.charAt(0).toUpperCase()
      ) : (
        <Radar className="size-4 text-gray-11" />
      )}
    </span>
  );

  const row = (
    <motion.button
      layout={!prefersReducedMotion}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen({ projectId: project.id, name });
      }}
      aria-label={`${name}, ${context}`}
      className={cn(
        'flex shrink-0 items-center gap-3 rounded-full text-sm text-gray-12 hover:bg-gray-4 hover:text-gray-12',
        collapsed
          ? 'size-9 cursor-pointer justify-center'
          : 'min-h-12 w-full min-w-0 px-3 py-1.5',
        active && 'bg-gray-4 font-medium text-gray-12',
      )}
    >
      {badge}
      {!collapsed && (
        <span className="block min-w-0 flex-1 text-left">
          <TextWithTooltip tooltipMessage={name}>
            <span className="block truncate">{name}</span>
          </TextWithTooltip>
          <span
            className="block truncate text-xs font-normal text-gray-11"
            title={context}
          >
            {context}
          </span>
        </span>
      )}
    </motion.button>
  );

  if (!collapsed) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right">
        {name}
        <br />
        {context}
      </TooltipContent>
    </Tooltip>
  );
}

function PinnedSortMenu({
  sort,
  onChange,
}: {
  sort: PinnedSort;
  onChange: (next: PinnedSort) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('Sort pinned projects')}
        className={cn(
          RAIL_HEADER_ICON_BUTTON,
          'flex items-center justify-center data-[state=open]:bg-gray-4',
        )}
      >
        <SlidersHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-48">
        <PinnedMenuOption
          label={t('Recently added')}
          active={sort === 'added'}
          onClick={() => onChange('added')}
        />
        <PinnedMenuOption
          label={t('Recently used')}
          active={sort === 'recency'}
          onClick={() => onChange('recency')}
        />
        <PinnedMenuOption
          label={t('Alphabetical')}
          active={sort === 'alphabetical'}
          onClick={() => onChange('alphabetical')}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PinnedMenuOption({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <DropdownMenuItem onClick={onClick} className="justify-between">
      {label}
      {active && <span className="text-accent-11">✓</span>}
    </DropdownMenuItem>
  );
}

function readStoredSort(stored: string | null): PinnedSort {
  return PINNED_SORTS.find((sort) => sort === stored) ?? 'added';
}

function lastFlowUpdatedAt(project: ProjectWithLimits): number {
  const lastFlowUpdated = project.analytics.lastFlowUpdated;
  if (isNil(lastFlowUpdated)) {
    return 0;
  }
  return new Date(lastFlowUpdated).getTime();
}

function compareProjects({ sort }: { sort: PinnedSort }) {
  return (a: ProjectWithLimits, b: ProjectWithLimits): number => {
    if (sort === 'alphabetical') {
      return getProjectName(a).localeCompare(getProjectName(b));
    }
    if (sort === 'added') {
      return new Date(b.created).getTime() - new Date(a.created).getTime();
    }
    const flowA = lastFlowUpdatedAt(a);
    const flowB = lastFlowUpdatedAt(b);
    if (flowA !== flowB) {
      return flowB - flowA;
    }
    return new Date(b.updated).getTime() - new Date(a.updated).getTime();
  };
}

function orderProjects({
  projects,
  sort,
}: {
  projects: ProjectWithLimits[];
  sort: PinnedSort;
}): ProjectWithLimits[] {
  const compare = compareProjects({ sort });
  const personal = projects.filter(
    (project) => project.type !== ProjectType.TEAM,
  );
  const others = projects.filter(
    (project) => project.type === ProjectType.TEAM,
  );
  return [...personal.sort(compare), ...others.sort(compare)];
}

function RailAccountRow({ collapsed }: { collapsed: boolean }) {
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const { data: user } = userHooks.useCurrentUser();
  const queryClient = useQueryClient();
  const hosted = useHostedBillingEnabled();
  const showPlatformAdmin = useIsPlatformAdmin();
  const { reachesMcp } = mcpHooks.useMcpReach({
    enabled: hosted && !!user && !showPlatformAdmin,
  });
  const trainer = usePlatformTrainerAccess();
  const workspaces = useOperationalWorkspaces();
  const navigate = useNavigate();

  if (!user) {
    return null;
  }

  const handleLogout = () => {
    userHooks.invalidateCurrentUser(queryClient);
    authenticationSession.logOut();
    navigate('/sign-in');
  };

  return (
    <div
      className={cn(
        'mt-2 flex items-center',
        collapsed ? 'flex-col-reverse gap-1' : 'justify-between px-2',
      )}
    >
      <DropdownMenu modal>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('Account')}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  'flex items-center gap-2 rounded-full hover:bg-gray-4',
                  collapsed
                    ? 'size-9 cursor-pointer justify-center'
                    : 'h-10 min-w-0 flex-1 px-2',
                )}
              >
                <div className="size-[22px] shrink-0 overflow-hidden rounded-full">
                  <UserAvatar
                    className={cn('size-full object-cover', {
                      'scale-150': isNil(user.imageUrl),
                    })}
                    name={user.firstName + ' ' + user.lastName}
                    email={user.email}
                    imageUrl={user.imageUrl}
                    size={22}
                    disableTooltip={true}
                  />
                </div>
                {!collapsed && (
                  <span className="min-w-0 flex-1 truncate text-left text-sm">
                    {user.firstName + ' ' + user.lastName}
                  </span>
                )}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          {collapsed && (
            <TooltipContent side="right">{t('Account')}</TooltipContent>
          )}
        </Tooltip>
        <DropdownMenuContent
          className="w-56 rounded-lg"
          side="right"
          align="end"
          sideOffset={10}
        >
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
              <div className="size-8 shrink-0 overflow-hidden rounded-full">
                <UserAvatar
                  className="size-full object-cover"
                  name={user.firstName + ' ' + user.lastName}
                  email={user.email}
                  imageUrl={user.imageUrl}
                  size={32}
                  disableTooltip={true}
                />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {user.firstName + ' ' + user.lastName}
                </span>
                <span className="truncate text-xs">{user.email}</span>
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem asChild>
              <Link to="/learn">
                <GraduationCap className="w-4 h-4 mr-2" />
                {t('Learning & certification')}
              </Link>
            </DropdownMenuItem>
            {trainer.allowed && (
              <DropdownMenuItem asChild>
                <Link to="/trainer">
                  <GraduationCap className="w-4 h-4 mr-2" />
                  {t('Trainer workspace')}
                </Link>
              </DropdownMenuItem>
            )}
            {workspaces.allowed && (
              <DropdownMenuItem asChild>
                <Link to="/partners/workspaces">
                  <BriefcaseBusiness className="w-4 h-4 mr-2" />
                  {t('Client workspaces')}
                </Link>
              </DropdownMenuItem>
            )}
            {hosted && user.platformRole === PlatformRole.ADMIN && (
              <DropdownMenuItem asChild>
                <Link to="/platform/users">
                  <Users className="w-4 h-4 mr-2" />
                  {t('Workspace users')}
                </Link>
              </DropdownMenuItem>
            )}

            {hosted && !showPlatformAdmin && reachesMcp && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SlidersHorizontal
                    className="mr-2 size-4"
                    aria-hidden="true"
                  />
                  {t('Developers')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem asChild>
                    <Link to="/mcp-server">
                      <Unplug className="mr-2 size-4" aria-hidden="true" />
                      {t('MCP Server')}
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuItem onClick={() => setAccountSettingsOpen(true)}>
              <UserCogIcon className="w-4 h-4 mr-2" />
              {t('Account Settings')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleLogout}>
            <LogOut className="w-4 h-4 mr-2" />
            {t('Log out')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 cursor-pointer rounded-full text-gray-11 hover:bg-gray-4 hover:text-gray-12"
            onClick={(e) => {
              e.stopPropagation();
              setAccountSettingsOpen(true);
            }}
            aria-label={t('Settings')}
          >
            <Settings className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">{t('Settings')}</TooltipContent>
      </Tooltip>

      <AccountSettingsDialog
        open={accountSettingsOpen}
        onClose={() => setAccountSettingsOpen(false)}
      />
    </div>
  );
}

const RAIL_HEADER_ICON_BUTTON =
  'size-6 rounded-md text-gray-11 hover:bg-gray-4 hover:text-gray-12 [&_svg]:size-3.5!';

const PINNED_SORT_KEY = 'rail-pinned-sort';

const PINNED_SORTS = ['added', 'recency', 'alphabetical'] as const;

type PinnedSort = (typeof PINNED_SORTS)[number];
