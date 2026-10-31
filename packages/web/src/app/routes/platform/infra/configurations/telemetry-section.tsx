import { t } from 'i18next';

import { SettingsPanel } from '@/app/components/admin';

export const TelemetrySection = () => (
  <SettingsPanel
    title={t('Telemetry')}
    description={t('Product and deployment telemetry are disabled for now.')}
  >
    <p className="text-sm leading-6 text-gray-11" role="status">
      {t(
        'Collection will stay off until a Sydekyks-owned capture plan is approved. Routine operational server logs continue to support reliability and troubleshooting.',
      )}
    </p>
  </SettingsPanel>
);
