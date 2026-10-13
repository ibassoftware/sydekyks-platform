import { createInstance } from 'i18next';
import ICU from 'i18next-icu';
import { beforeAll, describe, expect, it } from 'vitest';

import english from '../../public/locales/en/translation.json';

const i18n = createInstance();

beforeAll(async () => {
  await i18n.use(ICU).init({
    lng: 'en',
    keySeparator: false,
    nsSeparator: false,
    resources: { en: { translation: english } },
  });
});

describe('product language', () => {
  it('formats singular and plural command centers', () => {
    expect(i18n.t('projectsCount', { count: 1 })).toBe('1 command center');
    expect(i18n.t('projectsCount', { count: 3 })).toBe('3 command centers');
  });

  it('keeps supplied account and command center names intact', () => {
    expect(
      i18n.t('agentMoveLosesConnections', {
        count: 1,
        names: 'Project Flow Apps',
        project: 'Flow Project',
      }),
    ).toBe(
      'Project Flow Apps has no connected account in Flow Project, so that tool stops working until you connect it there.',
    );
  });

  it('formats nested gadget and action plurals', () => {
    expect(
      i18n.t('removingPiecesRemovesRequiredActions', {
        count: 2,
        actionCount: 3,
      }),
    ).toBe(
      'You are removing these gadgets from the set, which removes their 3 required actions. Your users will be able to publish their missions without including them.',
    );
  });

  it('preserves provider terminology and package identifiers', () => {
    expect(i18n.t('Google Cloud project ID')).toBe('Google Cloud project ID');
    expect(i18n.t('Configure OAuth2 App')).toBe('Configure OAuth2 App');
    expect(
      i18n.t('pieceNotAvailableOnInstanceNote', {
        pieceName: '@activepieces/piece-typeform',
        pieceVersion: '0.4.6',
      }),
    ).toContain('@activepieces/piece-typeform');
  });

  it('preserves CLI syntax and network recovery wording', () => {
    const instruction = 'Pass --scope project to keep it to one repository.';
    expect(i18n.t(instruction)).toBe(instruction);
    const networkError = 'It may have been deleted, or the connection dropped.';
    expect(i18n.t(networkError)).toBe(networkError);
    expect(i18n.t('reservedHeaderName')).toContain('Host and Connection');
    const oauthDescription =
      'Authenticate securely from your server using the Client Credentials flow. Ideal for backend integrations.';
    expect(i18n.t(oauthDescription)).toBe(oauthDescription);
    expect(
      i18n.t(
        'This request has expired. Go back to {client} and start the connection again.',
        { client: 'Claude Code' },
      ),
    ).toBe(
      'This request has expired. Go back to Claude Code and start connecting again.',
    );
  });

  it('distinguishes run counts from navigation history', () => {
    expect(i18n.t('Runs')).toBe('Runs');
    expect(i18n.t('Run history')).toBe('Run history');
  });

  it('renames literal nouns inside ICU plural branches', () => {
    const key =
      'You have {count} {count, plural, one {flow} other {flows}} without time saved per run. Add it to see your complete automation impact!';
    expect(i18n.t(key, { count: 1 })).toBe(
      'You have 1 mission without time saved per run. Add it to see your complete mission impact!',
    );
    expect(i18n.t(key, { count: 2 })).toBe(
      'You have 2 missions without time saved per run. Add it to see your complete mission impact!',
    );
  });
});
