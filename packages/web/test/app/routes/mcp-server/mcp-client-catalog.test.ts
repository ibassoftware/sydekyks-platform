import { describe, expect, it, vi } from 'vitest';

vi.mock('i18next', () => ({
  default: { language: 'en-US' },
  t: (key: string) => key,
}));

const { mcpClientCatalog } = await import(
  '@/app/routes/mcp-server/mcp-client-catalog'
);

const SERVER_URL = 'http://localhost:3000/mcp';

function clientNamed(key: string, isCloud: boolean) {
  return mcpClientCatalog
    .clients({
      serverUrl: SERVER_URL,
      websiteName: 'Sydekyks',
      isCloud,
    })
    .find((client) => client.key === key);
}

describe('mcpClientCatalog instance setup', () => {
  it.each([true, false])(
    'connects Claude to this instance for cloud=%s',
    (isCloud) => {
      const href =
        clientNamed('claude', isCloud)?.instructions[0].action?.href ?? '';
      const url = new URL(href);
      expect(url.searchParams.get('modal')).toBe('add-custom-connector');
      expect(url.searchParams.get('connectorUrl')).toBe(SERVER_URL);
      expect(url.searchParams.get('connectorName')).toBe('Sydekyks');
    },
  );

  it('uses provider docs and the instance deep link in both editions', () => {
    expect(clientNamed('cursor', true)?.docsUrl).toBe(
      'https://docs.cursor.com/context/mcp',
    );
    expect(clientNamed('cursor', true)).toEqual(clientNamed('cursor', false));
    expect(clientNamed('codex', true)).toEqual(clientNamed('codex', false));
  });
});

describe('mcpClientCatalog generated commands', () => {
  it('encodes the server url into the Cursor deep link', () => {
    const href =
      clientNamed('cursor', false)?.instructions[0].action?.href ?? '';
    const config = new URL(href).searchParams.get('config') ?? '';
    expect(JSON.parse(atob(config))).toEqual({ url: SERVER_URL });
  });

  it('encodes the server url into the VS Code deep link', () => {
    const href =
      clientNamed('vscode', false)?.instructions[0].action?.href ?? '';
    expect(JSON.parse(decodeURIComponent(href.split('?')[1]))).toEqual({
      name: 'sydekyks',
      type: 'http',
      url: SERVER_URL,
    });
  });

  it('builds the Claude Code add command', () => {
    expect(clientNamed('claude-code', false)?.instructions[0].command).toBe(
      `claude mcp add --transport http sydekyks ${SERVER_URL}`,
    );
  });
});
