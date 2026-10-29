import { t } from 'i18next';
import { GripVertical } from 'lucide-react';
import { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 360;

export function BuilderCopilotPanel({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [maximum, setMaximum] = useState(800);

  useEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const update = () => {
      const limit = Math.max(
        MIN_WIDTH,
        Math.min(800, Math.floor(parent.clientWidth / 2)),
      );
      setMaximum(limit);
      setWidth((current) => Math.min(current, limit));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const resize = (next: number) =>
    setWidth(Math.min(maximum, Math.max(MIN_WIDTH, next)));

  return (
    <aside
      ref={panel}
      aria-label={t('Ask Syd')}
      hidden={!open}
      style={{ '--ask-syd-width': `${width}px` } as CSSProperties}
      className={cn(
        'absolute inset-0 z-40 min-w-0 border-r border-gray-6 bg-panel xl:relative xl:inset-auto xl:z-auto xl:w-[var(--ask-syd-width)] xl:max-w-[50%] xl:shrink-0',
        !open && 'hidden',
      )}
    >
      {children}
      <div
        role="separator"
        aria-label={t('Resize Ask Syd')}
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maximum}
        aria-valuenow={width}
        tabIndex={open ? 0 : -1}
        className="absolute inset-y-0 -right-1 z-40 hidden w-2 touch-none cursor-col-resize items-center justify-center outline-none hover:bg-accent-5 focus-visible:bg-accent-5 focus-visible:ring-2 focus-visible:ring-accent-9 xl:flex"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
            return;
          event.preventDefault();
          resize(
            event.key === 'Home'
              ? MIN_WIDTH
              : event.key === 'End'
              ? maximum
              : width + (event.key === 'ArrowLeft' ? -32 : 32),
          );
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (drag.current)
            resize(drag.current.width + event.clientX - drag.current.x);
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <GripVertical
          aria-hidden
          className="size-3 shrink-0 rounded bg-gray-6 text-gray-11"
        />
      </div>
    </aside>
  );
}
