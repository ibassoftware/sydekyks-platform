import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AdminControl } from '@/lib/admin-control';

const CONTROL_ID_PATTERN =
  /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.(open|submit|confirm|toggle|select|copy|link|run)$/;

const SOURCE_ROOT = join(__dirname, '..', '..', 'src');
const ENUM_FILE = join(SOURCE_ROOT, 'lib', 'admin-control.ts');

const adminControlEntries = Object.entries(AdminControl);

// Keep stable telemetry IDs reserved while their controls are unavailable in
// this release. An inventory change must explicitly activate or retire an ID.
const reservedControls = [
  'GENERAL_BRANDING_UPGRADE_OPEN',
  'SSO_ALLOWED_DOMAIN_REMOVE_CONFIRM',
  'SSO_ALLOWED_DOMAIN_REMOVE_OPEN',
  'SSO_DOMAIN_ADD_OPEN',
  'SSO_DOMAIN_DNS_RECORD_OPEN',
  'SSO_DOMAIN_DNS_RUN',
  'SSO_DOMAIN_REMOVE_CONFIRM',
  'SSO_DOMAIN_REMOVE_OPEN',
  'SSO_DOMAIN_VERIFY_OPEN',
  'SSO_EMAIL_LOGIN_TOGGLE_CONFIRM',
  'SSO_GOOGLE_TOGGLE_CONFIRM',
  'SSO_SAML_ACS_URL_COPY',
  'SSO_SAML_DISABLE_CONFIRM',
  'SSO_SAML_ENTITY_ID_COPY',
];

const referencedControls = new Set(
  sourceFiles({ directory: SOURCE_ROOT })
    .filter((file) => file !== ENUM_FILE)
    .flatMap((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(
          /\bAdminControl\.([A-Z][A-Z0-9_]*)/g,
        ),
      ].map((match) => match[1]),
    ),
);

describe('AdminControl', () => {
  it('names every id area.thing.action with a verb from the fixed set', () => {
    const malformed = Object.values(AdminControl).filter(
      (id) => !CONTROL_ID_PATTERN.test(id),
    );

    expect(malformed).toEqual([]);
  });

  it('spells every member as its id in upper case with underscores', () => {
    const drifted = adminControlEntries.filter(
      ([member, id]) => member !== id.toUpperCase().replace(/[.-]/g, '_'),
    );

    expect(drifted).toEqual([]);
  });

  it('keeps the consent controls of the Configurations page out of the enum', () => {
    const consent = Object.values(AdminControl).filter((id) =>
      id.startsWith('configurations.'),
    );

    expect(consent).toEqual([]);
  });

  it('uses every active member and keeps only the explicit reserved inventory unused', () => {
    const unused = adminControlEntries
      .filter(([member]) => !referencedControls.has(member))
      .map(([member]) => member);

    expect(unused.sort()).toEqual([...reservedControls].sort());
    expect(reservedControls.every((member) => member in AdminControl)).toBe(
      true,
    );
  });

  it('never references an unknown control or reuses an id', () => {
    const members = new Set(adminControlEntries.map(([member]) => member));
    expect(
      [...referencedControls].filter((member) => !members.has(member)),
    ).toEqual([]);
    expect(new Set(Object.values(AdminControl)).size).toBe(
      adminControlEntries.length,
    );
  });
});

function sourceFiles({ directory }: { directory: string }): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles({ directory: path });
    }
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}
