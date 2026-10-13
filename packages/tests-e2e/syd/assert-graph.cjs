const { chromium, expect } = require('@playwright/test');

async function main() {
  const input = JSON.parse(process.env.SYD_GRAPH_BROWSER_INPUT || '{}');
  if (new URL(input.url).hostname !== '127.0.0.1') throw new Error('Only the isolated test app may be used');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1800 } });
  await context.addInitScript(({ token, projectId }) => { localStorage.setItem('token', token); localStorage.setItem('projectId', projectId); }, { token: input.token, projectId: input.projectId });
  const page = await context.newPage();
  page.on('pageerror', (error) => process.stderr.write(`Browser error: ${error.message}\n`));
  try {
    await page.goto(`${input.url}/projects/${input.projectId}/flows/${input.flowId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 90000 });
    await page.locator('button').filter({ has: page.locator('svg.lucide-fullscreen') }).click();
    for (const node of input.nodes) await expect(page.locator(`.react-flow__node[data-id="${node.id}"]`)).toContainText(node.label, { timeout: 30000 });
    for (const node of input.nodes) await expect(page.locator(`.react-flow__node[data-id="${node.id}"]`)).toBeInViewport({ ratio: 0.95 });
    const expectedEdges = [
      { id: 'trigger-step_1-edge', source: 'trigger', target: 'trigger-subgraph-end' },
      { id: 'step_1-step_2-edge', source: 'step_1', target: 'step_1-subgraph-end' },
      { id: 'step_2-loop-start-edge', source: 'step_2', target: 'step_3' },
      { id: 'step_2-loop-return-node', source: 'step_3-subgraph-end', target: 'step_2-loop-return-node' },
      { id: 'step_4-branch-0-start-edge', source: 'step_4', target: 'step_5' },
      { id: 'step_4-branch-1-start-edge', source: 'step_4', target: 'step_6' },
    ];
    for (const expected of expectedEdges) {
      const edge = page.locator(`.react-flow__edge[data-id="${expected.id}"]`);
      await expect(edge).toHaveAttribute('aria-label', `Edge from ${expected.source} to ${expected.target}`);
      const path = edge.locator('.react-flow__edge-path');
      await expect(path).toBeVisible();
      expect(await path.evaluate((element) => element.getTotalLength())).toBeGreaterThan(0);
    }
    await page.screenshot({ path: '/private/tmp/syd-copilot-graph.png', fullPage: true });
    process.stdout.write(JSON.stringify({ graphVisible: true, nodes: await page.locator('.react-flow__node').count(), edges: await page.locator('.react-flow__edge').count() }) + '\n');
  } finally { await browser.close(); }
}
main().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
