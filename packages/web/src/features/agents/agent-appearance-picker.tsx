import {
  Agent,
  AgentIcon,
  ColorName,
  isAgentImage,
  PICKABLE_COLOR_NAMES,
  PROJECT_COLOR_PALETTE,
  PROJECT_COLOR_SWATCH,
} from '@activepieces/shared';
import { t } from 'i18next';
import { ImagePlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { AgentMark } from './agent-mark';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const ICON_LABELS: Record<AgentIcon, string> = {
  [AgentIcon.BOT]: 'Robot',
  [AgentIcon.SPARKLES]: 'Sparkles',
  [AgentIcon.MESSAGE]: 'Message',
  [AgentIcon.USERS]: 'People',
  [AgentIcon.BOOK]: 'Book',
  [AgentIcon.CHART]: 'Chart',
  [AgentIcon.CALENDAR]: 'Calendar',
  [AgentIcon.MAIL]: 'Mail',
  [AgentIcon.GLOBE]: 'Globe',
  [AgentIcon.FILE]: 'Document',
  [AgentIcon.SEARCH]: 'Search',
  [AgentIcon.ZAP]: 'Lightning',
};

export async function normalizeAgentImage(file: File): Promise<string> {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  )
    throw new Error(t('Choose a PNG, JPEG or WebP image smaller than 5 MB.'));
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context)
      throw new Error(t('Image processing is unavailable in this browser.'));
    const scale = Math.max(256 / bitmap.width, 256 / bitmap.height);
    context.drawImage(
      bitmap,
      (256 - bitmap.width * scale) / 2,
      (256 - bitmap.height * scale) / 2,
      bitmap.width * scale,
      bitmap.height * scale
    );
    const result = canvas.toDataURL('image/webp', 0.8);
    if (!isAgentImage(result))
      throw new Error(
        t('This image is too complex. Choose a smaller or simpler image.')
      );
    return result;
  } finally {
    bitmap.close();
  }
}

export function AgentAppearancePicker({
  icon,
  color,
  onIconChange,
  onColorChange,
}: {
  icon: Agent['icon'];
  color: ColorName;
  onIconChange: (value: Agent['icon']) => void;
  onColorChange: (value: ColorName) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  const chooseIcon = (value: AgentIcon) => {
    generation.current++;
    setBusy(false);
    setError('');
    onIconChange(value);
  };
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-3 text-sm font-medium">{t('Appearance')}</legend>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t('Sydekyk icon')}
      >
        {Object.values(AgentIcon).map((value) => (
          <button
            type="button"
            key={value}
            aria-label={t(ICON_LABELS[value])}
            aria-pressed={icon === value}
            onClick={() => chooseIcon(value)}
            className={cn(
              'rounded-xl p-1 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-9',
              icon === value && 'ring-2 ring-accent-9'
            )}
          >
            <AgentMark icon={value} color={color} size="sm" />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {icon.startsWith('data:image/') && (
          <AgentMark icon={icon} color={color} />
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <ImagePlus aria-hidden className="size-4" />
          {busy ? t('Preparing image…') : t('Upload image')}
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label={t('Choose Sydekyk image')}
          className="sr-only"
          tabIndex={-1}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            const request = ++generation.current;
            setBusy(true);
            setError('');
            try {
              const value = await normalizeAgentImage(file);
              if (request === generation.current) onIconChange(value);
            } catch (cause) {
              if (request === generation.current)
                setError(
                  cause instanceof Error
                    ? cause.message
                    : t('Could not read this image. Choose another image.')
                );
            } finally {
              if (request === generation.current) setBusy(false);
            }
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger-11">
          {error}
        </p>
      )}
      <span className="text-sm font-medium">{t('Accent color')}</span>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t('Accent color')}
      >
        {PICKABLE_COLOR_NAMES.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={value}
            aria-pressed={
              PROJECT_COLOR_SWATCH[color] === PROJECT_COLOR_SWATCH[value]
            }
            onClick={() => onColorChange(value)}
            className={cn(
              'flex size-9 items-center justify-center rounded-lg border border-gray-6 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-9',
              PROJECT_COLOR_SWATCH[color] === PROJECT_COLOR_SWATCH[value] &&
                'ring-2 ring-gray-12'
            )}
          >
            <span
              className="size-5 rounded-full"
              style={{ backgroundColor: PROJECT_COLOR_PALETTE[value].color }}
            />
          </button>
        ))}
      </div>
    </fieldset>
  );
}
