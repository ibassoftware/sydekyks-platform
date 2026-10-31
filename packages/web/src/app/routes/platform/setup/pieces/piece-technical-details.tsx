import { PieceMetadataModelSummary } from '@activepieces/pieces-framework';
import { t } from 'i18next';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

export function PieceTechnicalDetails({ piece }: PieceTechnicalDetailsProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          {t('Technical Details')}
          <span className="sr-only">: {piece.displayName}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={16}
        className="max-w-[calc(100vw-2rem)]"
      >
        <div className="mb-3 font-medium">{piece.displayName}</div>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-gray-11">{t('Gadget ID')}</dt>
            <dd className="mt-1 break-all select-text">
              {piece.name.replace(/^@activepieces\/piece-/, '')}
            </dd>
          </div>
          <div>
            <dt className="text-gray-11">{t('Version')}</dt>
            <dd className="mt-1 select-text">{piece.version}</dd>
          </div>
        </dl>
      </PopoverContent>
    </Popover>
  );
}

type PieceTechnicalDetailsProps = {
  piece: PieceMetadataModelSummary;
};
