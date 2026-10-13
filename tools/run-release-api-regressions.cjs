// Keep release evidence aligned with the independently reviewed Syd/MCP scope.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const files = require('../scripts/release-api-regressions.json');
if (process.env.SYD_TEST_POSTGRES !== 'true' || process.env.SYD_TEST_REDIS !== 'true') {
    throw new Error('Release regressions require PostgreSQL concurrency and Redis approval tests');
}

if (!Array.isArray(files) || files.length === 0 || !files.every((file) =>
    typeof file === 'string'
    && file.startsWith('packages/server/api/test/')
    && file.endsWith('.test.ts')
    && !file.includes('..')
    && fs.existsSync(file))) {
    throw new Error('Release regression scope must contain existing API test files');
}

const reportPath = 'output/release-api-regressions.json';
fs.mkdirSync('output', { recursive: true });
fs.rmSync(reportPath, { force: true });
const result = spawnSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run',
    '--config', 'packages/server/api/vitest.config.ts', ...files,
    '--no-file-parallelism', '--maxWorkers=1',
    '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`,
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
if (!report.success || report.numPendingTests !== 0 || report.numFailedTests !== 0
    || report.testResults.length !== files.length
    || report.testResults.some((file) => file.status !== 'passed')) {
    throw new Error('All reviewed release API regressions must run and pass without skipped suites');
}
