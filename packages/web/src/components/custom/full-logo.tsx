import { t } from 'i18next';

import { flagsHooks } from '@/hooks/flags-hooks';
import { sydekyksBrand } from '@/lib/sydekyks-brand';
import { cn } from '@/lib/utils';

const FullLogo = ({ className }: { className?: string }) => {
  const branding = flagsHooks.useWebsiteBranding();
  const logoUrl = branding?.logos?.fullLogoUrl;
  const isSydekyksLogo =
    !logoUrl || logoUrl === sydekyksBrand.logos.fullLogoUrl;

  return (
    <div className={cn('h-[60px]', className)}>
      {isSydekyksLogo && (
        <span className="sydekyks-wordmark flex h-full items-center gap-2 text-3xl text-gray-12">
          sydekyks
          <svg
            viewBox="0 0 24 24"
            className="size-6 text-accent-11"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          >
            <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M5.6 18.4 18.4 5.6" />
          </svg>
        </span>
      )}
      {!isSydekyksLogo && logoUrl && (
        <img className="h-full" src={logoUrl} alt={t('logo')} />
      )}
    </div>
  );
};
FullLogo.displayName = 'FullLogo';
export { FullLogo };
