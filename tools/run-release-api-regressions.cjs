// Keep release evidence aligned with the independently reviewed Syd/MCP scope.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const files = require('../scripts/release-api-regressions.json');

if (!Array.isArray(files) || files.length === 0 || !files.every((file) =>
    typeof file === 'string'
    && file.startsWith('packages/server/api/test/')
    && file.endsWith('.test.ts')
    && !file.includes('..')
    && fs.existsSync(file))) {
    throw new Error('Release regression scope must contain existing API test files');
}

const result = spawnSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run',
    '--config', 'packages/server/api/vitest.config.ts', ...files,
    '--no-file-parallelism', '--maxWorkers=1',
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
