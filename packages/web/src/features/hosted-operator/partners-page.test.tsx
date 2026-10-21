// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  allowed: true,
  lookup: vi.fn(),
  queries: [] as unknown[],
  refetch: vi.fn(),
}));
vi.mock('i18next', () => ({ t: (value: string) => value }));
vi.mock('./operator-api', () => ({
  useHostedOperatorAccess: () => ({
    hosted: true,
    allowed: mocks.allowed,
    isPending: false,
    session: { kind: 'user', epoch: 'session' },
  }),
  operatorClientsQuery: () => ({ queryKey: ['clients'] }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (options: { queryKey: unknown[] }) => {
    mocks.queries.push(options.queryKey);
    return options.queryKey[0] === 'directory'
      ? {
          data: { total: 105, next: 'cursor', partners: [] },
          refetch: mocks.refetch,
        }
      : { data: { clients: [] }, refetch: mocks.refetch };
  },
}));
vi.mock('./partners-api', () => ({
  partnersQuery: (
    _session: unknown,
    after: unknown,
    _allowed: unknown,
    filters: unknown,
  ) => ({ queryKey: ['directory', after, filters] }),
  lookupPartner: mocks.lookup,
  decidePartner: vi.fn(),
  assignPartner: vi.fn(),
  PartnerAdminError: class extends Error {},
}));
vi.mock('./manual-account-form', () => ({
  ManualAccountForm: () => <p>Manual Partner creation form</p>,
}));
vi.mock('./partner-setup-controls', () => ({
  PartnerSetupControls: () => <p>Private setup link controls</p>,
}));
import { PartnersAdminPage } from './partners-page';
let element: HTMLDivElement, root: Root;
const pageText = () => element.textContent ?? '';
beforeEach(() => {
  mocks.allowed = true;
  mocks.lookup.mockReset();
  mocks.queries = [];
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
async function render() {
  // eslint-disable-next-line testing-library/no-unnecessary-act -- ReactDOM root.render requires act; this is not Testing Library render.
  await act(async () =>
    root.render(
      <MemoryRouter>
        <PartnersAdminPage />
      </MemoryRouter>,
    ),
  );
}
async function click(text: string) {
  const button = [...element.querySelectorAll('button')].find(
    (item) => item.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
describe('Partner administration views', () => {
  it('starts with a searchable directory and separates adding and setup from management', async () => {
    await render();
    expect(pageText()).toContain('105 Partners found');
    expect(element.querySelector('#partner-directory-search')).not.toBeNull();
    expect(pageText()).not.toContain('Manual Partner creation form');
    await click('Add Partner');
    expect(pageText()).toContain('Manual Partner creation form');
    expect(element.querySelector('#partner-directory-search')).toBeNull();
    await click('Setup links');
    expect(element.querySelector('#partner-email')).not.toBeNull();
    expect(pageText()).not.toContain('Manual Partner creation form');
  });
  it('keeps an unverified existing account in setup so its private link can be created', async () => {
    mocks.lookup.mockResolvedValue({
      candidate: {
        email: 'pending@example.invalid',
        verified: false,
        editable: true,
        role: null,
      },
    });
    await render();
    await click('Setup links');
    await act(async () =>
      element
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    expect(pageText()).toContain('Private setup link controls');
    expect(pageText()).not.toContain('Refresh account');
  });
  it('does not show administration controls to a tenant administrator denied by the server', async () => {
    mocks.allowed = false;
    await render();
    expect(element.querySelector('nav')).toBeNull();
    expect(element.querySelector('#partner-directory-search')).toBeNull();
    expect(pageText()).toContain('Only configured Sydekyks operators');
  });
});
