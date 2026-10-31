import { t } from 'i18next';
import { Moon } from 'lucide-react';

import { SettingRow } from './setting-row';

export const ThemeSetting = () => (
  <SettingRow title={t('Theme')}>
    <span className="flex items-center gap-2 text-sm text-gray-12">
      <Moon className="size-4" aria-hidden="true" />
      {t('Dark')}
    </span>
  </SettingRow>
);
