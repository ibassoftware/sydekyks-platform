import { Project, ProjectType } from '@activepieces/shared';
import { t } from 'i18next';
import { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getProjectName } from '@/features/projects';

export const NewBlankAgentButton = ({
  projects,
  projectId,
  pending,
  onCreate,
  variant = 'outline',
  size,
  className,
  icon,
  label,
}: NewBlankAgentButtonProps) => {
  const targetProject =
    projectId === undefined
      ? projects.find((project) => project.type === ProjectType.PERSONAL) ??
        (projects.length === 1 ? projects[0] : undefined)
      : projects.find((project) => project.id === projectId);

  if (targetProject !== undefined) {
    return (
      <Button
        variant={variant}
        size={size}
        className={className}
        loading={pending}
        disabled={pending}
        onClick={() => onCreate(targetProject.id)}
      >
        {icon}
        {label}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant}
          size={size}
          className={className}
          loading={pending}
          disabled={pending || projects.length === 0 || projectId !== undefined}
        >
          {icon}
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[220px]">
        <DropdownMenuLabel className="text-xs font-normal text-gray-11">
          {t('Create it in')}
        </DropdownMenuLabel>
        {projects.map((project) => (
          <DropdownMenuItem
            key={project.id}
            onSelect={() => onCreate(project.id)}
          >
            {getProjectName(project)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

type NewBlankAgentButtonProps = {
  projects: Project[];
  projectId?: string;
  pending: boolean;
  onCreate: (projectId: string) => void;
  variant?: 'outline' | 'default' | 'ghost';
  size?: 'sm';
  className?: string;
  icon: ReactNode;
  label: string;
};
