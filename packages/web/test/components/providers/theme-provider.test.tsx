// @vitest-environment jsdom
/* eslint-disable jest-dom/prefer-in-document, jest-dom/prefer-to-have-attribute, jest-dom/prefer-to-have-text-content, jest-dom/prefer-to-have-style -- No jest-dom runtime is installed. */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: {
    useWebsiteBranding: () => ({
      websiteName: 'Sydekyks',
      logos: {
        fullLogoUrl: '/branding/sydekyks-mark.svg',
        favIconUrl: '/branding/sydekyks-mark.svg',
      },
      colors: { primary: { default: '#18313b' } },
    }),
  },
}));
vi.mock('@/lib/brand-seed', () => ({ brandSeed: { apply: vi.fn() } }));
vi.mock('use-ripple-hook', () => ({ default: vi.fn() }));
import { ThemeSetting } from '@/app/components/account-settings/theme-setting';
import { ThemeProvider, useTheme } from '@/components/providers/theme-provider';

function Probe() {
  const { resolvedTheme } = useTheme();
  return (
    <>
      <output aria-label="Active theme">{resolvedTheme}</output>
      <ThemeSetting />
    </>
  );
}
beforeEach(() => {
  localStorage.clear();
  document.documentElement.setAttribute('data-theme', 'light');
  document.documentElement.style.colorScheme = 'light';
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(['light', 'system', 'dark'])(
  'keeps dark mode with a saved %s preference and a light device theme',
  (saved) => {
    localStorage.setItem('vite-ui-theme', saved);
    render(
      <ThemeProvider storageKey="vite-ui-theme">
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText('Active theme').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(localStorage.getItem('vite-ui-theme')).toBe('dark');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Light')).toBeNull();
    expect(screen.queryByText('System')).toBeNull();
  },
);
it('still renders dark mode when browser storage is blocked', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Synthetic storage restriction');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Synthetic storage restriction');
  });
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  expect(screen.getByLabelText('Active theme').textContent).toBe('dark');
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
});
