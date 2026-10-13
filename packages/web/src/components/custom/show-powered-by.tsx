import { t } from 'i18next';

import { flagsHooks } from '@/hooks/flags-hooks';
import { cn } from '@/lib/utils';

const ShowPoweredBy = ({ show, position = 'sticky' }: ShowPoweredByProps) => {
  const branding = flagsHooks.useWebsiteBranding();
  if (!show) return null;
  return (
    <div
      data-powered-by-branding="true"
      className={cn('bottom-0 right-3 pointer-events-none z-40', position, {
        '-mt-[30px]': position === 'sticky',
        'mr-5': position === 'sticky',
      })}
    >
      <div
        className={cn(
          'flex items-center justify-end gap-1 text-sm text-gray-11',
          position === 'static' && 'justify-center',
        )}
      >
        <span>{t('Built with')}</span>
        <img
          src={branding.logos.logoIconUrl}
          alt=""
          className={cn('size-4 shrink-0')}
        />
        <span className={cn('font-semibold')}>{branding.websiteName}</span>
      </div>
    </div>
  );
};

ShowPoweredBy.displayName = 'ShowPoweredBy';
export { ShowPoweredBy };

type ShowPoweredByProps = {
  show: boolean;
  position?: 'sticky' | 'absolute' | 'static';
};
