import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { flagsHooks } from '@/hooks/flags-hooks';

const PageTitle = ({ title, titleKey, children }: PageTitleProps) => {
  const websiteBranding = flagsHooks.useWebsiteBranding();
  const { t } = useTranslation();
  const translatedTitle = titleKey === undefined ? title : t(titleKey);

  useEffect(() => {
    document.title = `${translatedTitle} | ${websiteBranding.websiteName}`;
  }, [translatedTitle, websiteBranding.websiteName]);

  return children;
};

PageTitle.displayName = 'PageTitle';

export { PageTitle };

type PageTitleProps = {
  children: React.ReactNode;
} & ({ title: string; titleKey?: never } | { title?: never; titleKey: string });
