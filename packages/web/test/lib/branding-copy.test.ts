import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInstance } from 'i18next';
import ICU from 'i18next-icu';
import { describe, expect, it } from 'vitest';

const localeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/locales');
const locales = fs.readdirSync(localeRoot).filter((locale) => fs.existsSync(path.join(localeRoot, locale, 'translation.json')));

function readLocale(locale: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'translation.json'), 'utf8'));
}

describe('customer-facing branding', () => {
  it.each(locales)('has no upstream product branding in %s translated copy', (locale) => {
    const copy = readLocale(locale);
    const unexpected = Object.entries(copy).filter(([key, value]) => !key.includes('SP Entity ID') && key !== 'Optional telemetry sends usage events to the upstream Activepieces analytics service. Leave it disabled to avoid sharing usage data.' && /activepieces/i.test(value));
    expect(unexpected).toEqual([]);
  });

  it.each(locales)('uses the configured account name in %s MCP consent', async (locale) => {
    const i18n = createInstance();
    i18n.use(ICU);
    await i18n.init({ lng: locale, fallbackLng: 'en', resources: { en: { translation: readLocale('en') }, [locale]: { translation: readLocale(locale) } } });
    const result = i18n.t('wants to connect to your {platformName} account', { platformName: 'Example Workspace' });
    expect(result).toContain('Example Workspace');
    expect(result).not.toMatch(/activepieces/i);
  });
});
