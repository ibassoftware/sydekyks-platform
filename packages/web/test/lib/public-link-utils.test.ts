import { describe, expect, it } from 'vitest';

import { publicLinkUtils } from '@/lib/public-link-utils';

describe('optional public links', () => {
  it.each([
    'https://www.activepieces.com/docs/about/i18n',
    'https://activepieces.com/sales?feature=pieces',
    'https://community.activepieces.com',
    'https://feedback.activepieces.com',
    'https://github.com/activepieces/activepieces/releases',
    'mailto:support@activepieces.com?subject=Help',
    'javascript:alert(1)',
    '',
    undefined,
  ])('omits upstream promotion or unusable link %s', (url) => {
    expect(publicLinkUtils.isAllowed({ url })).toBe(false);
  });

  it.each([
    'https://sydekyks.com/help',
    'https://docs.example.com/gadgets',
    '/help',
    'mailto:help@example.com',
    'https://github.com/example/project',
    'https://github.com/activepieces-other/project',
    'https://cdn.activepieces.com/pieces/slack.png',
    'https://secrets.activepieces.com/redirect',
    'https://cloud.activepieces.com/api/v1',
    'https://api.activepieces.com/api/v1',
  ])('preserves configured destinations and functional endpoints %s', (url) => {
    expect(publicLinkUtils.isAllowed({ url })).toBe(true);
  });
});
