import { createContext, useContext, useEffect } from 'react';
import * as RippleHook from 'use-ripple-hook';

import { flagsHooks } from '@/hooks/flags-hooks';
import { brandSeed } from '@/lib/brand-seed';
import { sydekyksBrand } from '@/lib/sydekyks-brand';

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(
  undefined,
);

export function ThemeProvider({
  children,
  storageKey = 'ap-ui-theme',
  ...props
}: ThemeProviderProps) {
  const branding = flagsHooks.useWebsiteBranding();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.colorScheme = 'dark';
    try {
      localStorage.setItem(storageKey, 'dark');
    } catch {
      // Storage may be unavailable; the app still stays dark.
    }
  }, [storageKey]);

  useEffect(() => {
    if (!branding) {
      console.warn('Website brand is not defined');
      return;
    }
    if (!document.title.includes(' | ')) {
      document.title = branding.websiteName;
    }
    setFavicon(branding.logos.favIconUrl);
    if (branding.logos.fullLogoUrl === sydekyksBrand.logos.fullLogoUrl) {
      document.documentElement.setAttribute('data-brand', 'sydekyks');
    } else {
      document.documentElement.removeAttribute('data-brand');
    }

    brandSeed.apply({
      primaryColor: branding.colors.primary.default,
      statusColors: branding.statusColors,
    });
    if (
      branding.logos.fullLogoUrl === sydekyksBrand.logos.fullLogoUrl &&
      branding.colors.primary.default === sydekyksBrand.primaryColor
    ) {
      document.documentElement.setAttribute('data-brand-palette', 'sydekyks');
      document.documentElement.style.setProperty(
        '--on-accent',
        'var(--sydekyks-on-accent)',
      );
    } else {
      document.documentElement.removeAttribute('data-brand-palette');
    }
  }, [branding]);

  const value: ThemeProviderState = { resolvedTheme: 'dark' };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error('useTheme must be used within a ThemeProvider');

  return context;
};

export const useApRipple = () => {
  const { resolvedTheme } = useTheme();
  return RippleHook.default({
    color:
      resolvedTheme === 'dark'
        ? 'rgba(233, 233, 233, 0.2)'
        : 'rgba(155, 155, 155, 0.2)',
    cancelAutomatically: true,
  });
};

const setFavicon = (url: string) => {
  document.querySelectorAll("link[rel*='icon']").forEach((el) => el.remove());
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = url;
  document.head.appendChild(link);
};

export type ResolvedTheme = 'dark' | 'light';

type ThemeProviderProps = {
  children: React.ReactNode;
  storageKey?: string;
};

type ThemeProviderState = {
  resolvedTheme: ResolvedTheme;
};
