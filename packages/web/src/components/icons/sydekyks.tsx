import { Cpu, LucideIcon, Radar, Target } from 'lucide-react';
import { motion, useAnimation, useReducedMotion } from 'motion/react';
import { forwardRef, HTMLAttributes, useImperativeHandle } from 'react';

import { cn } from '@/lib/utils';

function createNavigationIcon({
  Icon,
  displayName,
}: {
  Icon: LucideIcon;
  displayName: string;
}) {
  const NavigationIcon = forwardRef<NavigationIconHandle, NavigationIconProps>(
    ({ className, size = 28, onMouseEnter, onMouseLeave, ...props }, ref) => {
      const controls = useAnimation();
      const reducedMotion = useReducedMotion();

      const startAnimation = () => {
        if (!reducedMotion) {
          controls.start({ rotate: [0, -8, 0] });
        }
      };
      const stopAnimation = () => controls.start({ rotate: 0 });

      useImperativeHandle(ref, () => ({ startAnimation, stopAnimation }));

      return (
        <motion.div
          className={cn('flex shrink-0 items-center justify-center', className)}
          animate={controls}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <div
            onMouseEnter={(event) => {
              startAnimation();
              onMouseEnter?.(event);
            }}
            onMouseLeave={(event) => {
              stopAnimation();
              onMouseLeave?.(event);
            }}
            {...props}
          >
            <Icon size={size} aria-hidden="true" className="block" />
          </div>
        </motion.div>
      );
    },
  );
  NavigationIcon.displayName = displayName;
  return NavigationIcon;
}

export const CommandCenterIcon = createNavigationIcon({
  Icon: Radar,
  displayName: 'CommandCenterIcon',
});
export const MissionIcon = createNavigationIcon({
  Icon: Target,
  displayName: 'MissionIcon',
});
export const GadgetIcon = createNavigationIcon({
  Icon: Cpu,
  displayName: 'GadgetIcon',
});

type NavigationIconHandle = {
  startAnimation: () => void;
  stopAnimation: () => void;
};

type NavigationIconProps = HTMLAttributes<HTMLDivElement> & {
  size?: number;
};
