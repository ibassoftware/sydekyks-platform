import { t } from 'i18next';

import { AdminPage, AdminPageHeader } from '@/app/components/admin';

import { TelemetrySection } from './telemetry-section';

export const ConfigurationsPage = () => (
  <AdminPage width="content">
    <AdminPageHeader title={t('Configurations')} />
    <TelemetrySection />
  </AdminPage>
);
