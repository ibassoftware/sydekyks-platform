import {
  ApEdition,
  ApFlagId,
  PlatformAdminSurface,
} from '@activepieces/shared';
import { t } from 'i18next';
import { ExternalLink, Lock } from 'lucide-react';
import { createContext, ReactNode, useContext } from 'react';

import { Button } from '@/components/ui/button';
import {
  FeatureKey,
  FeatureTier,
  TIER_LABELS,
  useUpgradeClick,
} from '@/features/billing';
import { flagsHooks } from '@/hooks/flags-hooks';
import { AdminControl, adminControl } from '@/lib/admin-control';
import { publicLinkUtils } from '@/lib/public-link-utils';

export function FeatureSample({
  locked,
  title,
  description,
  tier,
  documentationUrl,
  featureKey,
  children,
}: FeatureSampleProps) {
  const upgradeClick = useUpgradeClick();
  const { data: edition } = flagsHooks.useFlag<ApEdition>(ApFlagId.EDITION);

  if (!locked) {
    return children;
  }

  const isCommunity = edition === ApEdition.COMMUNITY;

  return (
    <div className="relative flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden">
      <div
        inert
        aria-hidden
        className="flex flex-1 min-h-0 min-w-0 flex-col pointer-events-none select-none opacity-25"
      >
        <InsideFeatureSampleContext.Provider value={true}>
          {children}
        </InsideFeatureSampleContext.Provider>
      </div>

      <div className="absolute inset-0 grid place-items-center overflow-auto p-6">
        <div className="pointer-events-auto flex w-full max-w-md flex-col items-center gap-5 rounded-2xl border bg-gray-1 px-8 py-9 text-center shadow-xl">
          <div className="grid size-12 place-items-center rounded-xl bg-accent-3">
            <Lock className="size-5.5 text-accent-11" />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">{t(title)}</h2>
            {description !== undefined && description !== '' && (
              <p className="text-sm leading-relaxed text-gray-11">
                {t(description)}
              </p>
            )}
          </div>
          {isCommunity ? (
            publicLinkUtils.isAllowed({ url: documentationUrl }) && (
              <a
                {...adminControl(AdminControl.PLAN_SAMPLE_LINK)}
                href={documentationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium text-accent-11 hover:underline"
              >
                {t('Read the docs')}
                <ExternalLink className="size-3.5" />
              </a>
            )
          ) : (
            <Button
              className="w-full"
              onClick={() =>
                upgradeClick({
                  feature: featureKey,
                  tier,
                  surface: PlatformAdminSurface.SAMPLE,
                })
              }
            >
              {tier === undefined
                ? t('Upgrade to unlock')
                : t('Upgrade to {tier}', { tier: TIER_LABELS[tier] })}
            </Button>
          )}
          {tier !== undefined && !isCommunity && (
            <>
              <div className="h-px w-full bg-gray-6" />
              <span className="text-xs text-gray-11">
                {t('Included with the {tier} plan and above.', {
                  tier: TIER_LABELS[tier],
                })}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function useInsideFeatureSample(): boolean {
  return useContext(InsideFeatureSampleContext);
}

const InsideFeatureSampleContext = createContext(false);

export type FeatureSampleProps = {
  locked: boolean;
  featureKey?: FeatureKey;
  showContactSales?: boolean;
  title: string;
  description?: string;
  tier?: FeatureTier;
  documentationUrl?: string;
  children: ReactNode;
};
