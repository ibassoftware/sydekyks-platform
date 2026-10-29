// @vitest-environment jsdom
import {
  AgentIcon,
  ColorName,
  CreateAgentRequest,
  isAgentImage,
} from '@activepieces/shared';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { AgentAppearancePicker } from './agent-appearance-picker';
import { AgentMark } from './agent-mark';
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=';
vi.mock('i18next', () => ({ t: (value: string) => value }));
afterEach(cleanup);
it('accepts bounded raster images through the server request schema and rejects remote, executable and oversized inputs', () => {
  expect(isAgentImage(png)).toBe(true);
  expect(CreateAgentRequest.shape.icon.safeParse(png).success).toBe(true);
  for (const bad of [
    'https://example.com/image.png',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,' + btoa('x'.repeat(50000)),
    'data:image/png;base64,AAAA',
  ])
    expect(isAgentImage(bad)).toBe(false);
});
it('renders every available icon and saves icon and color selection independently', () => {
  function Fixture() {
    const [icon, setIcon] = useState<string>(AgentIcon.BOT);
    const [color, setColor] = useState(ColorName.BLUE);
    return (
      <AgentAppearancePicker
        icon={icon}
        color={color}
        onIconChange={setIcon}
        onColorChange={setColor}
      />
    );
  }
  render(<Fixture />);
  expect(
    screen.getByRole('button', { name: 'Robot' }).getAttribute('aria-pressed')
  ).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Mail' }));
  expect(
    screen.getByRole('button', { name: 'Mail' }).getAttribute('aria-pressed')
  ).toBe('true');
  expect(
    screen.getByRole('button', { name: 'Robot' }).getAttribute('aria-pressed')
  ).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: ColorName.ORANGE }));
  expect(
    screen
      .getByRole('button', { name: ColorName.ORANGE })
      .getAttribute('aria-pressed')
  ).toBe('true');
});
it('shows a raster thumbnail with an icon fallback when decoding fails', () => {
  const { container } = render(<AgentMark icon={png} color={ColorName.BLUE} />);
  const image = container.querySelector('img')!;
  expect(image.src).toBe(png);
  fireEvent.error(image);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('svg')).not.toBeNull();
});
