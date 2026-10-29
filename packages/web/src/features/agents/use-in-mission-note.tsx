import { t } from 'i18next';
import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';

export function UseInMissionNote({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-col gap-2 border-t border-gray-6 pt-5">
      <h3 className="text-sm font-medium">
        {t('Use this Sydekyk in a Mission')}
      </h3>
      <p className="text-sm leading-5 text-gray-11">
        {t(
          'Set Sharing to Everyone in this Command Center and publish your changes. In a Mission in the same Command Center, add a step, choose AI & Sydekyks → Run Sydekyk, then pick this saved Sydekyk and enter its task in Prompt.'
        )}
      </p>
      <Button variant="link" className="h-auto self-start p-0" asChild>
        <Link
          to={`/projects/${projectId}/automations`}
          target="_blank"
          rel="noreferrer"
        >
          {t('Open Missions')}
          <ExternalLink className="ml-1 size-3.5" />
        </Link>
      </Button>
    </div>
  );
}
