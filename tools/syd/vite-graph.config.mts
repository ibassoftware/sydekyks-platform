import { fileURLToPath } from 'node:url';
import { defineConfig, loadConfigFromFile } from 'vite';

export default defineConfig(async () => {
  const apiUrl = process.env.SYD_TEST_API_URL;
  const port = Number(process.env.SYD_TEST_UI_PORT ?? 4319);
  if (!apiUrl || new URL(apiUrl).hostname !== '127.0.0.1') throw new Error('An isolated loopback API is required');
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'syd-e2e' }, fileURLToPath(new URL('../../packages/web/vite.config.mts', import.meta.url)));
  if (!loaded) throw new Error('Web configuration is missing');
  const headers = { Host: `127.0.0.1:${port}`, 'X-Forwarded-Host': `127.0.0.1:${port}` };
  const proxy = Object.fromEntries(['/api', '/mcp', '/.well-known', '/ingest'].map((path) => [path, { target: apiUrl, changeOrigin: true, ws: true, headers }]));
  return { ...loaded.config, server: { ...loaded.config.server, port, host: '127.0.0.1', strictPort: true, proxy } };
});
