import {
  AgentIcon,
  ColorName,
  PROJECT_COLOR_PALETTE,
} from '@activepieces/shared';
import { Bot } from 'lucide-react';

import { cn } from '@/lib/utils';

const SIZES = {
  sm: { box: 'size-8 rounded-xl', icon: 'size-5' },
  default: { box: 'size-12 rounded-[14px]', icon: 'size-8' },
  welcome: { box: 'size-[60px] rounded-[14px]', icon: 'size-10' },
} as const;

type AgentMarkProps = {
  // Kept for existing saved agents and API compatibility. A Sydekyk now has one
  // recognizable robot mark rather than a configurable geometric character.
  icon: AgentIcon;
  color: ColorName;
  size?: keyof typeof SIZES;
};

export const AgentMark = ({ color, size = 'default' }: AgentMarkProps) => (
  <div
    className={cn(
      'flex shrink-0 items-center justify-center border border-gray-6 bg-gray-1',
      SIZES[size].box,
    )}
  >
    <Bot
      aria-hidden
      className={SIZES[size].icon}
      style={{ color: PROJECT_COLOR_PALETTE[color].color }}
      strokeWidth={1.8}
    />
  </div>
);

export const AgentTrioMark = ({ className }: { className?: string }) => (
  <div
    className={cn(
      'flex h-[104px] w-[236px] shrink-0 items-center justify-center gap-5',
      className,
    )}
    aria-hidden
  >
    <Bot className="size-12 text-gray-11" strokeWidth={1.5} />
    <Bot className="size-16 text-accent-11" strokeWidth={1.5} />
    <Bot className="size-12 text-gray-11" strokeWidth={1.5} />
  </div>
);
