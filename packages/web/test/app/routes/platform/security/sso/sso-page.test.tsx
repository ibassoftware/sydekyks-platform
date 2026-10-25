/** @vitest-environment jsdom */
/* eslint-disable jest-dom/prefer-in-document, jest-dom/prefer-to-have-attribute, jest-dom/prefer-to-have-value, jest-dom/prefer-enabled-disabled -- No jest-dom runtime is installed. */
import {
  ApFlagId,
  PlatformWithoutSensitiveData,
  SsoDomainVerificationRecordType,
  SsoDomainVerificationStatus,
} from '@activepieces/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import * as React from 'react';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { SSOPage } from '@/app/routes/platform/security/sso';
import { AllowedDomainDialog } from '@/app/routes/platform/security/sso/allowed-domain';
import { ConfigureSamlDialog } from '@/app/routes/platform/security/sso/saml-dialog';

const state = vi.hoisted(() => ({
  platform: {} as PlatformWithoutSensitiveData,
  update: vi.fn(),
  updateDomain: vi.fn(),
  verifyDomain: vi.fn(),
  refetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock('i18next', () => ({
  t: (key: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replace(`{${name}}`, value),
      key,
    ),
}));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/api/platforms-api', () => ({
  platformApi: { update: (...args: unknown[]) => state.update(...args) },
}));
vi.mock('@/features/platform-admin/api/saml-sso-api', () => ({
  samlSsoApi: {
    updateSsoDomain: (...args: unknown[]) => state.updateDomain(...args),
    verifySsoDomain: () => state.verifyDomain(),
  },
}));
// Exercise the real SSO mutation hook, avoiding unrelated barrel exports/services.
vi.mock('@/features/platform-admin', async () => ({
  ssoMutations: (await import('@/features/platform-admin/hooks/sso-hooks'))
    .ssoMutations,
  samlSsoApi: {
    updateSsoDomain: (...args: unknown[]) => state.updateDomain(...args),
    verifySsoDomain: () => state.verifyDomain(),
  },
}));
vi.mock('@/hooks/platform-hooks', () => ({
  platformHooks: {
    useCurrentPlatform: () => ({
      platform: state.platform,
      refetch: state.refetch,
    }),
  },
}));
vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: {
    queryKey: ['flags'],
    useFlag: (id: string) => ({
      data:
        id === ApFlagId.SAML_AUTH_ACS_URL
          ? 'https://selfhost.test/acs'
          : undefined,
    }),
  },
}));
vi.mock('@/lib/api', () => ({
  api: {
    extractServerErrorMessage: (error: unknown, fallback: string) =>
      error instanceof Error ? error.message : fallback,
  },
}));
vi.mock('@/components/custom/markdown', () => ({
  ApMarkdown: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}));
vi.mock('@/components/custom/clipboard/copy-to-clipboard', () => ({
  CopyToClipboardInput: ({ textToCopy }: { textToCopy: string }) => (
    <input readOnly value={textToCopy} />
  ),
}));
// Vitest does not load Tailwind's generated stylesheet. Apply the real hidden
// utility so role queries reflect which wizard step users can actually reach.
const utilityStyles = document.createElement('style');
utilityStyles.textContent = '.hidden { display: none; }';
beforeAll(() => document.head.append(utilityStyles));
afterAll(() => utilityStyles.remove());

const pendingVerification = {
  status: SsoDomainVerificationStatus.PENDING_VERIFICATION,
  record: {
    type: SsoDomainVerificationRecordType.TXT,
    name: '_activepieces.acme.com',
    value: 'verification-sample',
  },
  createdAt: '2026-10-25T00:00:00.000Z',
};
const verifiedVerification = {
  ...pendingVerification,
  status: SsoDomainVerificationStatus.VERIFIED,
};
function setPlatform(overrides: Partial<PlatformWithoutSensitiveData> = {}) {
  state.platform = {
    id: 'platform-one',
    ssoDomain: null,
    ssoDomainVerification: null,
    allowedAuthDomains: [],
    federatedAuthProviders: {},
    emailAuthEnabled: true,
    googleAuthEnabled: false,
    ...overrides,
  } as PlatformWithoutSensitiveData;
}
function mount(children: React.ReactNode = <SSOPage />) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
  return client;
}
async function openSaml() {
  mount(
    <ConfigureSamlDialog
      platform={state.platform}
      connected={!!state.platform.federatedAuthProviders?.saml}
      refetch={state.refetch}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: state.platform.federatedAuthProviders?.saml ? 'Edit' : 'Enable',
    }),
  );
  return screen.findByRole('dialog');
}
async function openAllowedDomains() {
  mount(
    <AllowedDomainDialog platform={state.platform} refetch={state.refetch} />,
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: state.platform.allowedAuthDomains.length ? 'Update' : 'Enable',
    }),
  );
  return screen.findByRole('dialog');
}
beforeEach(() => {
  vi.clearAllMocks();
  state.update.mockReset().mockResolvedValue(undefined);
  state.updateDomain.mockReset().mockResolvedValue(undefined);
  state.verifyDomain
    .mockReset()
    .mockResolvedValue({ ssoDomainVerification: pendingVerification });
  state.refetch.mockReset().mockResolvedValue(undefined);
  setPlatform();
});
describe('current self-hosted SSOPage', () => {
  it('presents current authentication controls without a removed setup-page link', () => {
    mount();
    expect(
      screen.getByRole('heading', { name: 'Single Sign On' }),
    ).toBeTruthy();
    expect(screen.getByText('Allowed Domains')).toBeTruthy();
    expect(screen.getByText('SAML 2.0')).toBeTruthy();
    expect(screen.getByText('Allowed Email Login')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Set up' })).toBeNull();
    const switches = screen.getAllByRole('switch');
    expect(switches[0].getAttribute('aria-checked')).toBe('false');
    expect(switches[1].getAttribute('aria-checked')).toBe('true');
  });
  it.each([
    [pendingVerification, 'Pending verification'],
    [verifiedVerification, 'Verified'],
  ] as const)(
    'shows the actual domain verification state',
    (verification, label) => {
      setPlatform({
        ssoDomain: 'acme.com',
        ssoDomainVerification: verification,
      });
      mount();
      expect(screen.getByText('acme.com')).toBeTruthy();
      expect(screen.getByText(label)).toBeTruthy();
    },
  );
  it('scopes Google and email changes to this platform and refreshes flags', async () => {
    const client = mount();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getAllByRole('switch')[0]);
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith(
        { googleAuthEnabled: true },
        'platform-one',
      ),
    );
    fireEvent.click(screen.getAllByRole('switch')[1]);
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith(
        { emailAuthEnabled: false },
        'platform-one',
      ),
    );
    await waitFor(() => expect(state.refetch).toHaveBeenCalledTimes(2));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['flags'] });
    await waitFor(() =>
      expect(state.toast.success).toHaveBeenCalledWith(
        'Email authentication updated',
        { duration: 3000 },
      ),
    );
  });
  it('disables the relevant toggle while its update is pending', async () => {
    let resolve!: () => void;
    state.update.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    mount();
    fireEvent.click(screen.getAllByRole('switch')[0]);
    await waitFor(() =>
      expect(screen.getAllByRole('switch')[0].hasAttribute('disabled')).toBe(
        true,
      ),
    );
    expect(screen.getAllByRole('switch')[1].hasAttribute('disabled')).toBe(
      false,
    );
    resolve();
    await waitFor(() =>
      expect(screen.getAllByRole('switch')[0].hasAttribute('disabled')).toBe(
        false,
      ),
    );
  });
});
describe('current allowed-domain dialog', () => {
  it('edits existing domains and enforces the submitted list', async () => {
    setPlatform({ allowedAuthDomains: ['acme.com'] });
    const dialog = within(await openAllowedDomains());
    fireEvent.change(dialog.getByDisplayValue('acme.com'), {
      target: { value: 'partners.io' },
    });
    await waitFor(() =>
      expect(
        (dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith(
        {
          allowedAuthDomains: ['partners.io'],
          enforceAllowedAuthDomains: true,
        },
        'platform-one',
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.refetch).toHaveBeenCalledOnce();
  });
  it('keeps Save disabled for an added empty domain', async () => {
    const dialog = within(await openAllowedDomains());
    fireEvent.click(dialog.getByRole('button', { name: 'Add Domain' }));
    expect(dialog.getByPlaceholderText('example.com')).toBeTruthy();
    await waitFor(() =>
      expect(
        (dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(state.update).not.toHaveBeenCalled();
  });
  it('supports clearing the list and explicitly disables enforcement', async () => {
    setPlatform({ allowedAuthDomains: ['acme.com'] });
    const dialog = within(await openAllowedDomains());
    // The existing remove-row button contains an X icon without an accessible name.
    fireEvent.click(dialog.getByRole('button', { name: '' }));
    expect(dialog.queryByDisplayValue('acme.com')).toBeNull();
    await waitFor(() =>
      expect(
        (dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith(
        { allowedAuthDomains: [], enforceAllowedAuthDomains: false },
        'platform-one',
      ),
    );
  });
  it('cancels without sending changes', async () => {
    const dialog = within(await openAllowedDomains());
    fireEvent.click(dialog.getByRole('button', { name: 'Add Domain' }));
    fireEvent.change(dialog.getByPlaceholderText('example.com'), {
      target: { value: 'acme.com' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.update).not.toHaveBeenCalled();
  });
});
describe('current SAML configuration dialog', () => {
  it('keeps Next unavailable until DNS verification is satisfied', async () => {
    const dialog = within(await openSaml());
    expect(
      (dialog.getByRole('button', { name: 'Next' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(dialog.queryByRole('textbox', { name: 'IDP Metadata' })).toBeNull();
  });
  it('normalizes and saves a new SSO domain before configuring SAML', async () => {
    const dialog = within(await openSaml());
    fireEvent.change(dialog.getByRole('textbox', { name: 'Domain' }), {
      target: { value: 'Acme.com' },
    });
    await waitFor(() =>
      expect(
        (
          dialog.getByRole('button', {
            name: 'Save domain',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Save domain' }));
    await waitFor(() =>
      expect(state.updateDomain).toHaveBeenCalledWith('acme.com'),
    );
    expect(state.update).not.toHaveBeenCalled();
    expect(state.refetch).toHaveBeenCalledOnce();
  });
  it('shows domain-save errors while preserving the typed value', async () => {
    state.updateDomain.mockRejectedValueOnce(
      new Error('Domain already registered'),
    );
    const dialog = within(await openSaml());
    const input = dialog.getByRole('textbox', { name: 'Domain' });
    fireEvent.change(input, { target: { value: 'acme.com' } });
    await waitFor(() =>
      expect(
        (
          dialog.getByRole('button', {
            name: 'Save domain',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Save domain' }));
    expect(await dialog.findByText('Domain already registered')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('acme.com');
  });
  it('shows the pending DNS record and remains on the domain step when it is not found', async () => {
    setPlatform({
      ssoDomain: 'acme.com',
      ssoDomainVerification: pendingVerification,
    });
    const dialog = within(await openSaml());
    expect(dialog.getByDisplayValue('_activepieces.acme.com')).toBeTruthy();
    expect(dialog.getByDisplayValue('verification-sample')).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Verify DNS' }));
    await waitFor(() => expect(state.verifyDomain).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(state.toast.message).toHaveBeenCalledWith(
        'TXT record not found yet — DNS can take a few minutes.',
      ),
    );
    expect(dialog.queryByRole('textbox', { name: 'IDP Metadata' })).toBeNull();
  });
  it('unlocks SAML fields after a successful DNS check', async () => {
    setPlatform({
      ssoDomain: 'acme.com',
      ssoDomainVerification: pendingVerification,
    });
    state.verifyDomain.mockResolvedValueOnce({
      ssoDomainVerification: verifiedVerification,
    });
    const dialog = within(await openSaml());
    fireEvent.click(dialog.getByRole('button', { name: 'Verify DNS' }));
    expect(
      await dialog.findByRole('textbox', { name: 'IDP Metadata' }),
    ).toBeTruthy();
    expect(state.toast.success).toHaveBeenCalledWith('Domain verified');
  });
  it('asks for confirmation before replacing an existing SSO domain', async () => {
    setPlatform({
      ssoDomain: 'acme.com',
      ssoDomainVerification: pendingVerification,
    });
    const dialog = within(await openSaml());
    fireEvent.change(dialog.getByRole('textbox', { name: 'Domain' }), {
      target: { value: 'new.example' },
    });
    await waitFor(() =>
      expect(
        (
          dialog.getByRole('button', {
            name: 'Update domain',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Update domain' }));
    const confirmation = await screen.findByRole('dialog', {
      name: 'Update SSO domain?',
    });
    expect(state.updateDomain).not.toHaveBeenCalled();
    fireEvent.click(
      within(confirmation).getByRole('button', { name: 'Update domain' }),
    );
    await waitFor(() =>
      expect(state.updateDomain).toHaveBeenCalledWith('new.example'),
    );
  });
  it('submits required SAML metadata and certificate for a verified domain', async () => {
    setPlatform({
      ssoDomain: 'acme.com',
      ssoDomainVerification: verifiedVerification,
    });
    const dialog = within(await openSaml());
    expect(
      (dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(dialog.getByText(/https:\/\/selfhost.test\/acs/)).toBeTruthy();
    fireEvent.change(dialog.getByRole('textbox', { name: 'IDP Metadata' }), {
      target: { value: '<xml />' },
    });
    fireEvent.change(dialog.getByRole('textbox', { name: 'IDP Certificate' }), {
      target: { value: 'certificate' },
    });
    await waitFor(() =>
      expect(
        (dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith(
        {
          federatedAuthProviders: {
            saml: { idpMetadata: '<xml />', idpCertificate: 'certificate' },
          },
        },
        'platform-one',
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.refetch).toHaveBeenCalledOnce();
  });
  it('disables an existing SAML connection using the current dialog action', async () => {
    setPlatform({
      ssoDomain: 'acme.com',
      ssoDomainVerification: verifiedVerification,
      federatedAuthProviders: {
        saml: {},
      },
    });
    const dialog = within(await openSaml());
    fireEvent.click(dialog.getByRole('button', { name: 'Disable' }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith(
        { federatedAuthProviders: { saml: null } },
        'platform-one',
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.refetch).toHaveBeenCalledOnce();
  });
});
