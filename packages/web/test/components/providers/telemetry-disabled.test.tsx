// @vitest-environment jsdom
/* eslint-disable jest-dom/prefer-in-document, jest-dom/prefer-to-have-attribute, jest-dom/prefer-to-have-text-content -- This suite has no jest-dom runtime extension. */
import { TelemetryEventName } from '@activepieces/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { sessionScoped: send } }));
vi.mock('@/lib/error-reporting', () => ({
  errorReporting: { init: vi.fn(), flushBuffered: vi.fn() },
}));
vi.mock('@/app/components/admin', () => ({
  AdminPage: ({ children }: PropsWithChildren) => <main>{children}</main>,
  AdminPageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  SettingsPanel: ({
    title,
    description,
    children,
  }: PropsWithChildren<{ title: string; description: string }>) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </section>
  ),
}));
vi.mock('i18next', () => ({ t: (text: string) => text }));
import { ConfigurationsPage } from '@/app/routes/platform/infra/configurations';
import TelemetryProvider, {
  useTelemetry,
} from '@/components/providers/telemetry-provider';
function Feature() {
  const { capture } = useTelemetry();
  return (
    <button
      onClick={() =>
        capture({
          name: TelemetryEventName.CREATED_FLOW,
          payload: { flowId: 'synthetic-flow' },
        })
      }
    >
      Use a feature
    </button>
  );
}
describe('telemetry deferred in the UI', () => {
  it('keeps product actions working without submitting analytics', () => {
    render(
      <TelemetryProvider>
        <Feature />
      </TelemetryProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use a feature' }));
    expect(send).not.toHaveBeenCalled();
  });
  it('explains the pause without switches or a save action that could re-enable collection', () => {
    render(<ConfigurationsPage />);
    expect(
      screen.getByText(
        'Product and deployment telemetry are disabled for now.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
  });
});
