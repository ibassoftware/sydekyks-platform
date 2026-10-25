// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Sidebar,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from './sidebar-shadcn';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true }));

function Fixture({ showTrigger = true }: { showTrigger?: boolean }) {
  const { setOpenMobile } = useSidebar();
  return (
    <>
      <Sidebar>
        <button onClick={() => setOpenMobile(false)}>
          Navigate within platform
        </button>
      </Sidebar>
      {showTrigger && <SidebarTrigger aria-label="Open platform navigation" />}
      <button id="destination">Destination</button>
    </>
  );
}
let root: Root, container: HTMLDivElement;
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
  });
}
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    await settle();
  });
  container.remove();
});
async function render(showTrigger = true) {
  // React DOM createRoot does not provide Testing Library’s automatic act wrapper.
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => {
    root.render(
      <SidebarProvider>
        <Fixture showTrigger={showTrigger} />
      </SidebarProvider>,
    );
    await settle();
  });
}
describe('mobile platform navigation focus', () => {
  it('opens once through the native trigger and returns focus after Escape', async () => {
    await render();
    const trigger = container.querySelector(
      '[aria-label="Open platform navigation"]',
    )!;
    await click(trigger);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await settle();
    });
    // No jest-dom runtime is installed; assert the actual native focus target.
    // eslint-disable-next-line jest-dom/prefer-focus
    expect(document.activeElement).toBe(trigger);
  });
  it('returns focus when navigation closes the sheet and the trigger remains mounted', async () => {
    await render();
    const trigger = container.querySelector(
      '[aria-label="Open platform navigation"]',
    )!;
    await click(trigger);
    await click(document.querySelector('[role="dialog"] button')!);
    // No jest-dom runtime is installed; assert the actual native focus target.
    // eslint-disable-next-line jest-dom/prefer-focus
    expect(document.activeElement).toBe(trigger);
  });
  it('does not focus a disconnected trigger after navigation unmounts it', async () => {
    await render();
    const trigger = container.querySelector(
      '[aria-label="Open platform navigation"]',
    ) as HTMLButtonElement;
    await click(trigger);
    const focus = vi.spyOn(trigger, 'focus');
    await render(false);
    await click(document.querySelector('[role="dialog"] button')!);
    expect(trigger.isConnected).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });
});
