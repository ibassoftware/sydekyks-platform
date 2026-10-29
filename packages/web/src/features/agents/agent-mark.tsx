import {
  Agent,
  AgentIcon,
  ColorName,
  PROJECT_COLOR_PALETTE,
} from '@activepieces/shared';
import {
  BookOpen,
  Bot,
  Calendar,
  ChartLine,
  FileText,
  Globe,
  Mail,
  MessageSquare,
  Search,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

export const AGENT_ICON_COMPONENTS = {
  [AgentIcon.BOT]: Bot,
  [AgentIcon.SPARKLES]: Sparkles,
  [AgentIcon.MESSAGE]: MessageSquare,
  [AgentIcon.USERS]: Users,
  [AgentIcon.BOOK]: BookOpen,
  [AgentIcon.CHART]: ChartLine,
  [AgentIcon.CALENDAR]: Calendar,
  [AgentIcon.MAIL]: Mail,
  [AgentIcon.GLOBE]: Globe,
  [AgentIcon.FILE]: FileText,
  [AgentIcon.SEARCH]: Search,
  [AgentIcon.ZAP]: Zap,
};

const SIZES = {
  sm: { box: 'size-8 rounded-xl', icon: 'size-5' },
  default: { box: 'size-12 rounded-[14px]', icon: 'size-8' },
  welcome: { box: 'size-[60px] rounded-[14px]', icon: 'size-10' },
} as const;

type AgentMarkProps = {
  icon: Agent['icon'];
  color: ColorName;
  size?: keyof typeof SIZES;
};

export const AgentMark = ({
  icon,
  color,
  size = 'default',
}: AgentMarkProps) => {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [icon]);
  const image = icon.startsWith('data:image/') && !imageFailed;
  const Icon = AGENT_ICON_COMPONENTS[icon as AgentIcon] ?? Bot;
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden border border-gray-6 bg-gray-1',
        SIZES[size].box
      )}
    >
      {image ? (
        <img
          src={icon}
          alt=""
          className="size-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <Icon
          aria-hidden
          className={SIZES[size].icon}
          style={{ color: PROJECT_COLOR_PALETTE[color].color }}
          strokeWidth={1.8}
        />
      )}
    </div>
  );
};

export const AgentTrioMark = ({ className }: { className?: string }) => (
  <div
    className={cn(
      'flex h-[104px] w-[236px] shrink-0 items-center justify-center gap-5',
      className
    )}
    aria-hidden
  >
    <Bot className="size-12 text-gray-11" strokeWidth={1.5} />
    <Bot className="size-16 text-accent-11" strokeWidth={1.5} />
    <Bot className="size-12 text-gray-11" strokeWidth={1.5} />
  </div>
);
