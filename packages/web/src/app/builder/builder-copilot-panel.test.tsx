// @vitest-environment jsdom
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BuilderCopilotPanel } from './builder-copilot-panel';
vi.mock('i18next', () => ({ t: (value: string) => value }));
afterEach(cleanup);
it('keeps the conversation mounted while hidden and restores it when reopened', () => {
  const { rerender } = render(
    <BuilderCopilotPanel open={false}>
      <input aria-label="Draft" defaultValue="Unsaved question" />
    </BuilderCopilotPanel>
  );
  expect(screen.queryByRole('complementary', { name: 'Ask Syd' })).toBeNull();
  rerender(
    <BuilderCopilotPanel open>
      <input aria-label="Draft" defaultValue="" />
    </BuilderCopilotPanel>
  );
  expect(
    (screen.getByRole('textbox', { name: 'Draft' }) as HTMLInputElement).value
  ).toBe('Unsaved question');
});
it('resizes from the keyboard within the available canvas bounds', () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    value: 1600,
  });
  render(
    <BuilderCopilotPanel open>
      <p>Conversation</p>
    </BuilderCopilotPanel>
  );
  const handle = screen.getByRole('separator', { name: 'Resize Ask Syd' });
  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  expect(handle.getAttribute('aria-valuenow')).toBe('392');
  fireEvent.keyDown(handle, { key: 'Home' });
  expect(handle.getAttribute('aria-valuenow')).toBe('280');
  fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  expect(handle.getAttribute('aria-valuenow')).toBe('280');
  fireEvent.keyDown(handle, { key: 'End' });
  expect(handle.getAttribute('aria-valuenow')).toBe('800');
});
