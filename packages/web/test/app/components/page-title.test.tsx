// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PageTitle } from '@/app/components/page-title';

import english from '../../../public/locales/en/translation.json';

vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: { useWebsiteBranding: () => ({ websiteName: 'Sydekyks' }) },
}));

const i18n = createInstance();

beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: english } },
  });
});

afterEach(cleanup);

describe('PageTitle', () => {
  it('translates a built-in page title', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <PageTitle titleKey="Flows">Missions</PageTitle>
      </I18nextProvider>,
    );
    expect(document.title).toBe('Missions | Sydekyks');
  });

  it.each(['Projects', 'Flows', 'Apps', 'Chat'])(
    'preserves the supplied name %s even when it is a translation key',
    (title) => {
      render(
        <I18nextProvider i18n={i18n}>
          <PageTitle title={title}>Template details</PageTitle>
        </I18nextProvider>,
      );
      expect(document.title).toBe(`${title} | Sydekyks`);
    },
  );
});
