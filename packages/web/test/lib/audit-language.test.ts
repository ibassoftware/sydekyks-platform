import { ApplicationEventName, buildMockEvent } from '@activepieces/shared';
import i18n from 'i18next';
import ICU from 'i18next-icu';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildEventLabels } from '@/app/routes/platform/infra/event-destinations/lib/event-labels';
import { summarizeAuditEvent } from '@/app/routes/platform/security/audit-logs/audit-language';

import english from '../../public/locales/en/translation.json';

beforeAll(async () => {
  await i18n.use(ICU).init({
    lng: 'en',
    keySeparator: false,
    nsSeparator: false,
    resources: { en: { translation: english } },
  });
});

describe('audit display language', () => {
  it.each(Object.values(ApplicationEventName))(
    'formats %s without changing the recorded event',
    (action) => {
      const event = buildMockEvent({
        event: action,
        platformId: 'platform',
        projectId: 'project',
      });
      const recorded = JSON.stringify(event);
      expect(buildEventLabels()[action]).toBeTruthy();
      expect(summarizeAuditEvent(event)).toBeTruthy();
      expect(JSON.stringify(event)).toBe(recorded);
    },
  );

  it('preserves supplied names containing the original product terms', () => {
    const event = buildMockEvent({
      event: ApplicationEventName.FLOW_PUBLISHED,
      platformId: 'platform',
      projectId: 'project',
    });
    if (event.action !== ApplicationEventName.FLOW_PUBLISHED)
      throw new Error('Unexpected mock event');
    event.data.flowVersion.displayName = 'Project Flow Agent';
    expect(summarizeAuditEvent(event)).toBe(
      'Mission "Project Flow Agent" was published',
    );
  });

  it('uses Sydekyks event labels while preserving enum values', () => {
    const labels = buildEventLabels();
    expect(labels[ApplicationEventName.FLOW_CREATED]).toBe('Mission created');
    expect(labels[ApplicationEventName.PROJECT_ROLE_CREATED]).toBe(
      'Command Center role created',
    );
    expect(labels[ApplicationEventName.AGENT_CREATED]).toBe('Sydekyk created');
    expect(ApplicationEventName.FLOW_CREATED).toBe('flow.created');
  });
});
