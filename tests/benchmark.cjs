const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const html = path.resolve(process.argv[2] || 'markdown-editor.html');
  const browser = await chromium.launch(process.env.BENCH_CHROME
    ? { executablePath: process.env.BENCH_CHROME, args: ['--disable-gpu', '--disable-software-rasterizer'] } : {});
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(html).href);
    await page.waitForFunction(() => ready);
    const result = await page.evaluate(async () => {
      const field = document.querySelector('#editor');
      const body = Array.from({ length: 5000 },
        (_, i) => '## Heading ' + i + '\n\nA line with **bold**, code and text.\n\n').join('');
      const samples = [];
      for (let i = -3; i < 30; i++) {
        field.value = body + '\n中文 draft ' + i;
        const start = performance.now();
        field.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中文' }));
        if (i >= 0) samples.push(performance.now() - start);
      }
      const finalEdit = performance.now();
      while (!document.querySelector('#preview')?.textContent.includes('中文 draft 29')) {
        if (performance.now() - finalEdit > 10000) throw new Error('Latest preview was not rendered');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      samples.sort((a, b) => a - b);
      return { browser: navigator.userAgent, characters: body.length, runs: samples.length,
        p95: samples[Math.ceil(0.95 * samples.length) - 1],
        finalPreviewMs: performance.now() - finalEdit, samples };
    });
    console.log(JSON.stringify(result, null, 2));
    if (process.argv[3]) assert.ok(result.p95 <= Number(process.argv[3]) / 2, 'Input P95 must fall by at least 50%');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
