import {
  ApFlagId,
  brandColors,
  DEFAULT_BRAND_LOGOS,
  StatusColors,
} from '@activepieces/shared';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { sydekyksBrand } from '@/lib/sydekyks-brand';

import { flagsApi, FlagsMap } from '../api/flags-api';

type WebsiteBrand = {
  websiteName: string;
  logos: {
    fullLogoUrl: string;
    favIconUrl: string;
    logoIconUrl: string;
  };
  colors: {
    avatar: string;
    'blue-link': string;
    danger: string;
    selection: string;
    primary: {
      default: string;
      dark: string;
      light: string;
      medium: string;
    };
    warn: {
      default: string;
      light: string;
      dark: string;
    };
    success: {
      default: string;
      light: string;
    };
  };
  statusColors?: StatusColors;
};
const queryKey = ['flags'];
export const flagsHooks = {
  queryKey,
  useFlags: () => {
    return useSuspenseQuery<FlagsMap, Error>({
      queryKey,
      queryFn: flagsApi.getAll,
      staleTime: Infinity,
    });
  },
  useWebsiteBranding: () => {
    const { data: theme } = flagsHooks.useFlag<WebsiteBrand>(ApFlagId.THEME);
    return useMemo(() => {
      if (!theme) {
        throw new Error('Website branding is unavailable');
      }
      return {
        ...theme,
        websiteName: /^activepieces$/i.test(theme.websiteName.trim())
          ? sydekyksBrand.name
          : theme.websiteName,
        logos: {
          fullLogoUrl:
            theme.logos.fullLogoUrl === DEFAULT_BRAND_LOGOS.fullLogoUrl
              ? sydekyksBrand.logos.fullLogoUrl
              : theme.logos.fullLogoUrl,
          logoIconUrl:
            theme.logos.logoIconUrl === DEFAULT_BRAND_LOGOS.logoIconUrl
              ? sydekyksBrand.logos.logoIconUrl
              : theme.logos.logoIconUrl,
          favIconUrl:
            theme.logos.favIconUrl === DEFAULT_BRAND_LOGOS.favIconUrl
              ? sydekyksBrand.logos.favIconUrl
              : theme.logos.favIconUrl,
        },
        colors: {
          ...theme.colors,
          primary: {
            ...theme.colors.primary,
            default:
              theme.colors.primary.default === brandColors.defaultPrimaryColor()
                ? sydekyksBrand.primaryColor
                : theme.colors.primary.default,
          },
        },
      };
    }, [theme]);
  },
  useFlag: <T>(flagId: ApFlagId) => {
    const data = useSuspenseQuery<FlagsMap, Error>({
      queryKey: ['flags'],
      queryFn: flagsApi.getAll,
      staleTime: Infinity,
    }).data?.[flagId] as T | null;
    return {
      data,
    };
  },
};
