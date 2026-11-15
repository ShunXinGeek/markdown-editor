const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium, firefox } = require('playwright');
const { spawnSync } = require('node:child_process');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const http = require('node:http');

const output = path.join(process.cwd(), 'dist');
const python = process.platform === 'win32' ? 'python' : 'python3';

async function serve() {
  const result = spawnSync(python, ['build-static.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const headers = Object.fromEntries((await readFile(path.join(output, '_headers'), 'utf8')).trim().split('\n').slice(1)
    .map(line => { const i = line.indexOf(':'); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
  const server = http.createServer(async (req, res) => {
    try {
      let pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/') pathname = '/markdown-editor.html';
      const file = path.resolve(output, '.' + pathname);
      if (!file.startsWith(output + path.sep)) throw new Error();
      const type = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json',
        '.css': 'text/css', '.woff2': 'font/woff2', '.zip': 'application/zip' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { ...headers, 'Content-Type': type }).end(await readFile(file));
    } catch (_) { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port + '/', close: () => server.close() };
}

async function edit(page, text) {
  await page.locator('#editor').fill(text);
  await page.evaluate(() => saveToLocal());
}
async function launchPage(browser, url, offline = false) {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => { localStorage.setItem('md_editor_help_shown', 'true'); });
  if (offline) await context.route('https://cdn.jsdelivr.net/**', route => route.abort());
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  await page.waitForFunction(() => typeof ready !== 'undefined' && ready);
  return { context, page };
}
async function download(page, action) {
  const [download] = await Promise.all([page.waitForEvent('download'), action()]);
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

test('Python proxy contract and bounded transport', () => {
  const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('static site browser regression', { timeout: 180000 }, async t => {
  const server = await serve();
  t.after(server.close);
  for (const engine of [chromium, firefox]) {
    await t.test(engine.name() + ': offline, input, keyboard, migration, recovery and conflict', async sub => {
      const browser = await engine.launch();
      sub.after(() => browser.close());
      const { context, page } = await launchPage(browser, server.url, true);
      await page.evaluate(() => {
        localStorage.setItem('md_editor_content', 'legacy');
        localStorage.setItem('md_editor_filename', 'legacy.md');
      });
      await page.reload();
      await page.waitForFunction(() => ready && draft.text === 'legacy');
      await page.locator('#export-dropdown > button').focus();
      await page.keyboard.press('Enter');
      await page.locator("[data-i18n='exportMd']").waitFor();
      await page.keyboard.press('Escape');
      const text = 'Heading\n-------\n\n**Bold** <u>ok</u>\n\n<iframe title="removed"></iframe>';
      await edit(page, text);
      assert.equal(await page.locator('#preview iframe').count(), 0);
      assert.equal(await page.locator('#preview h2').textContent(), 'Heading');
      assert.equal(await page.locator('#preview u').textContent(), 'ok');
      assert.equal(await page.evaluate(() => {
        const dicts = Object.values(i18n);
        const keys = Object.keys(dicts[0]).sort().join(',');
        return dicts.length === 10 && dicts.every(dict => Object.keys(dict).sort().join(',') === keys);
      }), true);
      await page.reload();
      await page.waitForFunction(value => ready && draft.text === value, text);

      for (let i = 0; i < 12; i++) await edit(page, 'checkpoint ' + i);
      const history = await page.evaluate(() => draftStorage.revisions(draft.id));
      assert.equal(history.length, 10);
      assert.equal(history[0].text, 'checkpoint 11');
      assert.equal(history.at(-1).text, 'checkpoint 2');

      await page.locator('[onclick="openRecovery()"]').click();
      await page.waitForFunction(() => document.querySelector('#recovery-list').options.length === 10);
      await page.locator('#recovery-list').selectOption('5');
      assert.equal(await page.locator('#recovery-preview').inputValue(), 'checkpoint 6');
      await page.locator('#recovery-apply').click();
      await page.waitForFunction(() => draft.text === 'checkpoint 6' && !dirtyDraft());
      const second = await context.newPage();
      await second.goto(server.url);
      await second.waitForFunction(() => ready);
      await edit(page, 'first tab');
      await edit(second, 'retained conflict');
      assert.equal(await second.evaluate(() => saveStatus), 'draftConflict');
      assert.equal(await second.locator('#editor').inputValue(), 'retained conflict');
      await second.close();
      await context.close();
    });
  }

  await t.test('Chromium: Markdown, HTML, DOCX, PDF, PNG', async sub => {
    const browser = await chromium.launch();
    sub.after(() => browser.close());
    const { page } = await launchPage(browser, server.url);
    const png = await page.evaluate(() => document.createElement('canvas').toDataURL());
    const markdown = '# Export fixture\n\n3. Third\n4. Fourth\n\n![Fixture](' + png + ')';
    const name = page.locator('#filename');
    const editor = page.locator('#editor');
    const clear = page.locator('[onclick="clearDoc()"]');
    const exportAs = async key => {
      await page.locator('#export-dropdown > button').click();
      await page.locator('#export-menu [data-i18n="' + key + '"]').click();
    };
    for (const extension of ['md', 'MARKDOWN', 'txt']) {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#import-button').click()]);
      await chooser.setFiles({ name: '会议纪要.v2.' + extension, mimeType: 'text/plain', buffer: Buffer.from(markdown) });
      await page.waitForFunction(value => draft.text === value && !dirtyDraft(), markdown);
      assert.equal(await name.inputValue(), '会议纪要.v2');
      assert.equal(await editor.inputValue(), markdown);
      await clear.click();
      await page.waitForFunction(() => !draft.text && !draft.filename && !dirtyDraft());
      assert.equal(await name.inputValue(), '');
      assert.equal(await editor.inputValue(), '');
    }
    await page.reload();
    await page.waitForFunction(() => ready);
    assert.equal(await name.inputValue(), '');
    assert.equal(await editor.inputValue(), '');

    await page.locator('#importFile').setInputFiles({ name: '会议纪要.txt', mimeType: 'text/plain', buffer: Buffer.from(markdown) });
    await page.waitForFunction(value => draft.text === value && !dirtyDraft(), markdown);
    const imported = await download(page, () => exportAs('exportMd'));
    assert.equal(imported.name, '会议纪要.md');
    await name.fill('会议纪要.定稿');
    const md = await download(page, () => exportAs('exportMd'));
    assert.equal(md.name, '会议纪要.定稿.md');
    assert.equal(md.bytes.toString(), markdown);
    const html = await download(page, () => exportAs('exportHtml'));
    assert.equal(html.name, '会议纪要.定稿.html');
    assert.match(html.bytes.toString(), /<h1>Export fixture<\/h1>/);
    const bundle = await download(page, () => exportAs('attachmentZip'));
    assert.equal(bundle.name, '会议纪要.定稿.zip');
    const docx = await download(page, () => exportAs('exportWord'));
    assert.equal(docx.name, '会议纪要.定稿.docx');
    const temp = await mkdtemp(path.join(os.tmpdir(), 'md-editor-'));
    sub.after(() => rm(temp, { recursive: true, force: true }));
    const file = path.join(temp, 'sample.docx');
    await require('node:fs/promises').writeFile(file, docx.bytes);
    const result = spawnSync(python, ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert any(p.endswith(".png") and p.startswith("word/media/") for p in z.namelist()); assert b"numPr" in z.read("word/document.xml"); assert b\'w:start w:val="3"\' in z.read("word/numbering.xml")', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const title = await page.title();
    await page.evaluate(() => { window.print = () => window.printCalled = document.title; });
    await exportAs('exportPdf');
    await page.waitForFunction(() => window.printCalled);
    assert.equal(await page.evaluate(() => window.printCalled), '会议纪要.定稿.pdf');
    const pdf = await page.pdf();
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.match(pdf.toString('latin1'), /\/Type\s*\/Page\b/);
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    assert.equal(await page.title(), title);
    await exportAs('exportImage');
    await page.waitForFunction(() => Boolean(currentImageDataUrl), null, { timeout: 20000 });
    const [width, height] = await page.locator('#export-image-preview').evaluate(el => [el.naturalWidth, el.naturalHeight]);
    assert.deepEqual([width,height], [1080, 1920]);
    const image = await download(page, () => page.locator('[data-i18n="downloadPng"]').click());
    assert.equal(image.name, '会议纪要.定稿.png');
  });
});


test('list presets, editable hierarchy and document fonts in Chromium', { timeout: 60000 }, async t => {
  const server = await serve();
  t.after(server.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, context } = await launchPage(browser, server.url);
  const editor = page.locator('#editor');
  const select = (start, end = start) => editor.evaluate((el, range) => {
    el.focus();
    el.setSelectionRange(...range);
  }, [start, end]);
  const openMenu = id => page.locator(`button[aria-controls="${id}-menu"]`).click();
  const pick = async (menu, style) => {
    await openMenu(menu);
    await page.locator(`[data-list-preset="${style}"]`).click();
  };
  const exportAs = async key => {
    await page.locator('#export-dropdown > button').click();
    await page.locator(`#export-menu [data-i18n="${key}"]`).click();
  };
  const numbered = '7. First\n8. **Second**\n9. Third';
  await edit(page, numbered);
  await select(4, numbered.indexOf('9.'));
  await pick('unordered', 'diamond');
  assert.deepEqual(await page.locator('#preview [data-list-style="diamond"] > li').allTextContents(), ['First', 'Second']);
  assert.equal(await page.locator('#preview > div > ol').getAttribute('start'), '9');
  await pick('ordered', 'upper-roman');
  assert.deepEqual(await page.locator('#preview [data-list-style="upper-roman"] > li').allTextContents(), ['First', 'Second']);
  await page.locator('[onclick="undo()"]').click();
  assert.equal(await page.locator('#preview [data-list-style="diamond"]').count(), 1);
  await page.locator('[onclick="redo()"]').click();
  assert.equal(await page.locator('#preview [data-list-style="upper-roman"]').count(), 1);
  assert.equal(await page.locator('#preview strong').textContent(), 'Second');
  await page.locator('button[aria-controls="ordered-menu"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-list-preset="decimal-dot"]').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('button[aria-controls="ordered-menu"]').getAttribute('aria-expanded'), 'false');
  await edit(page, 'A. Smith wrote this.\n\n1. Item\n\n       A. Indented code\n       B. Indented code\n\n2. Another item');
  assert.equal(await page.locator('#preview > div > p').textContent(), 'A. Smith wrote this.');
  assert.equal(await page.locator('#preview pre').textContent(), 'A. Indented code\nB. Indented code\n');

  let hierarchy = '壹、甲\nA. 字母甲\n(1) 数字甲\n(2) 数字乙\nB. 字母乙\n贰、乙\nA. 字母丙\n(1) 数字丙';
  await edit(page, hierarchy + '\n\n```text\nA. 原样\n(1) 原样\n```');
  const root = page.locator('#preview > div > ol[data-list-style="chinese-formal-comma"]');
  const alpha = root.locator('> li > ol[data-list-style="upper-alpha"]');
  const digits = alpha.first().locator('> li > ol[data-list-style="decimal-parens"]').first();
  assert.deepEqual(await digits.locator('> li').allTextContents(), ['数字甲', '数字乙']);
  assert.equal(await root.locator('> li').count(), 2);
  assert.equal(await alpha.count(), 2);
  assert.equal(await page.locator('#preview pre').textContent(), 'A. 原样\n(1) 原样\n');
  await select(hierarchy.indexOf('\n(2)'));
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('插入');
  assert.deepEqual(await digits.locator('> li').allTextContents(), ['数字甲', '插入', '数字乙']);
  hierarchy = await editor.inputValue();
  await select(hierarchy.indexOf('(1) 数字甲'), hierarchy.indexOf('(1) 插入'));
  await page.keyboard.press('Backspace');
  assert.deepEqual(await digits.locator('> li').allTextContents(), ['插入', '数字乙']);

  await openMenu('font');
  await page.locator('#custom-font').fill('Times New Roman');
  await page.locator('#custom-font-form button').click();
  assert.match(await editor.inputValue(), /^<!-- md-font: Times New Roman -->\n\n/);
  assert.equal(await root.evaluate(el => getComputedStyle(el).fontFamily), '"Times New Roman", sans-serif');
  await page.evaluate(() => saveToLocal());
  await page.reload();
  await page.waitForFunction(() => ready);
  assert.equal(await root.evaluate(el => getComputedStyle(el).fontFamily), '"Times New Roman", sans-serif');
  const html = await download(page, () => exportAs('exportHtml'));
  const exported = await context.newPage();
  await exported.setContent(html.bytes.toString(), { waitUntil: 'domcontentloaded' });
  const savedList = exported.locator('ol[data-list-style="decimal-parens"]').first();
  assert.equal(await savedList.evaluate(el => getComputedStyle(el).listStyleType), 'md-list-decimal-parens');
  assert.equal(await savedList.evaluate(el => getComputedStyle(el).fontFamily), '"Times New Roman", sans-serif');
  await exported.close();
  const md = await download(page, () => exportAs('exportMd'));
  assert.equal(md.bytes.toString(), await editor.inputValue());

  const word = await download(page, () => exportAs('exportWord'));
  const files = require('../vendor/fflate.js').unzipSync(word.bytes);
  const xml = name => Buffer.from(files[`word/${name}.xml`]).toString();
  assert.match(xml('styles'), /w:eastAsia="Times New Roman"/);
  assert.match(xml('numbering'), /w:numFmt w:val="chineseLegalSimplified"/);
  assert.match(xml('numbering'), /w:numFmt w:val="upperLetter"/);
  assert.match(xml('numbering'), /w:lvlText w:val="\(%3\)"/);
  const wordLists = [...xml('document').matchAll(/<w:ilvl w:val="([0-2])"\/><w:numId w:val="(\d+)"\/>/g)];
  assert.deepEqual([...new Set(wordLists.map(match => match[1]))], ['0', '1', '2']);
  assert.equal(new Set(wordLists.map(match => match[2])).size, 1);
  assert.doesNotMatch(xml('document'), /壹、甲|A\. 字母甲|\(1\) 插入/);

  await page.evaluate(() => { window.print = () => { window.printCalled = true; }; });
  await exportAs('exportPdf');
  await page.waitForFunction(() => window.printCalled);
  assert.equal(await page.locator('#pdf-document .markdown-body').evaluate(el => getComputedStyle(el).fontFamily),
    '"Times New Roman", sans-serif');
  const pdf = await page.pdf();
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));

  async function exportListImage(style) {
    await edit(page, '1. <!-- md-list:' + style + ' --> Image export');
    await exportAs('exportImage');
    await page.waitForFunction(() => Boolean(currentImageDataUrl));
    const image = await download(page, () => page.locator('[data-i18n="downloadPng"]').click());
    await page.locator('#export-image-modal button[data-i18n="cancel"]').click();
    return image.bytes;
  }
  assert.equal((await exportListImage('decimal-parens')).equals(await exportListImage('upper-alpha')), false);
});

test('model settings explain how to start the service when the editor is opened as a file', { timeout: 30000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const url = pathToFileURL(path.join(process.cwd(), 'markdown-editor.html')).href;
  const { page } = await launchPage(browser, url, true);
  await page.setViewportSize({ width: 375, height: 550 });
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模型设置' });
  const status = dialog.getByRole('status');
  await dialog.getByLabel('模型供应商').selectOption('deepseek');
  await dialog.getByLabel('API Key').fill('fixture-key');
  await dialog.getByLabel('模型名称').fill('fixture-model');
  await dialog.getByRole('button', { name: '测试连接' }).click();
  assert.match(await status.textContent(), /python numbering-model\.py/);
  assert.equal(await status.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === el;
  }), true);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  assert.match(await status.textContent(), /python numbering-model\.py/);
  assert.equal(await dialog.getByLabel('模型名称').inputValue(), 'fixture-model');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('#organize-numbering').click();
  await page.locator('#toast.show').filter({ hasText: 'python numbering-model.py' }).waitFor();
  assert.equal(await dialog.isVisible(), false);
});

test('model settings fill provider URLs, save and use the selected model', { timeout: 30000 }, async t => {
  const server = await serve();
  t.after(server.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page } = await launchPage(browser, server.url, true);
  const open = page.getByRole('button', { name: '模型设置', exact: true });
  const dialog = page.getByRole('dialog', { name: '模型设置' });
  const provider = dialog.getByLabel('模型供应商');
  const key = dialog.getByLabel('API Key');
  const baseUrl = dialog.getByLabel('Base URL');
  const model = dialog.getByLabel('模型名称');
  const status = dialog.getByRole('status');
  const save = dialog.getByRole('button', { name: '保存', exact: true });
  await page.setViewportSize({ width: 375, height: 667 });
  await open.click();
  assert.equal(await provider.evaluate(el => el === document.activeElement), true);
  await provider.selectOption('deepseek');
  assert.equal(await baseUrl.inputValue(), 'https://api.deepseek.com');
  assert.equal(await key.getAttribute('type'), 'password');
  await key.fill('deepseek-fixture-key');
  await model.fill('fixture-deepseek');
  await provider.selectOption('dashscope');
  assert.equal(await baseUrl.inputValue(), 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(await key.inputValue(), '');
  assert.equal(await model.inputValue(), '');
  await model.fill('fixture-qwen');
  await save.click();
  assert.match(await status.textContent(), /API Key/);
  await key.fill('fixture-key');
  await baseUrl.fill('http://provider.example/v1');
  await save.click();
  assert.match(await status.textContent(), /HTTPS/);
  await baseUrl.fill('https://provider.example/custom/v1');

  const testConnection = dialog.getByRole('button', { name: '测试连接' });
  await page.route('**/api/numbering', route => route.fulfill({ status: 501 }));
  await testConnection.click();
  await status.filter({ hasText: 'python numbering-model.py' }).waitFor();
  await page.unroute('**/api/numbering');

  const actions = [];
  await page.route('**/api/numbering', async route => {
    const payload = route.request().postDataJSON();
    actions.push(payload.action);
    assert.equal(payload.model, 'fixture-qwen');
    assert.deepEqual(payload.connection, { baseUrl: 'https://provider.example/custom/v1', apiKey: 'fixture-key' });
    if (payload.action === 'analyze') {
      const id = payload.candidates[0].id;
      await route.fulfill({ json: { items: [{ id, kind: 'heading', level: 1, group: id,
        style: 'outline', start: 0, review: false }] } });
    } else {
      await route.fulfill({ json: { provider: 'provider.example', model: payload.model } });
    }
  });
  await testConnection.click();
  await status.filter({ hasText: '连接成功' }).waitFor();
  await save.click();
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('#toast.show').filter({ hasText: '模型设置已保存' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('md_editor_numbering_settings').includes('fixture-key')), false);
  await page.reload();
  await page.waitForFunction(() => ready);
  await open.click();
  assert.equal(await provider.inputValue(), 'dashscope');
  assert.equal(await baseUrl.inputValue(), 'https://provider.example/custom/v1');
  assert.equal(await model.inputValue(), 'fixture-qwen');
  assert.equal(await key.inputValue(), 'fixture-key');
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (this === localStorage && name === 'md_editor_numbering_settings') {
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      }
      return setItem.call(this, name, value);
    };
  });
  await key.fill('unsaved-key');
  await save.click();
  assert.match(await status.textContent(), /无法保存模型设置/);
  assert.equal(await key.inputValue(), 'unsaved-key');
  await provider.selectOption('moonshot');
  assert.equal(await baseUrl.inputValue(), 'https://api.moonshot.cn/v1');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await open.evaluate(el => el === document.activeElement), true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await edit(page, '# 9. Scope');
  await page.locator('#organize-numbering').click();
  await page.locator('#preview [data-number-label]').waitFor();
  assert.deepEqual(actions, ['test', 'status', 'analyze']);
  const newTab = await context.newPage();
  await newTab.goto(server.url);
  await newTab.waitForFunction(() => ready);
  await newTab.getByRole('button', { name: '模型设置', exact: true }).click();
  assert.equal(await newTab.getByLabel('API Key').inputValue(), '');
  assert.equal(await newTab.getByLabel('模型名称').inputValue(), 'fixture-qwen');
});

test('numbering results stay in the right preview and exports are manual', { timeout: 90000 }, async t => {
  const server = await serve();
  t.after(server.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page } = await launchPage(browser, server.url);
  const protectedContent = await page.evaluate(() => {
    const original = '# 第三章範圍  \r\n\r\n\t10. code\r\n\r\n## 第十五條約定 **原文**\r\n\r\n' +
      '依照第十五條，保留 \x60x = 2\x60、12.34 元及空格。  \r\n';
    const candidates = editorNumbering.find(original);
    const titles = candidates.map(candidate => candidate.body);
    const choices = editorNumbering.decisions(candidates, { items: candidates.map((candidate, index) => ({
      id: candidate.id, kind: 'heading', group: candidates[0].id, level: index + 1,
      style: 'auto', start: 0, review: false
    })) });
    const result = editorNumbering.patch(original, candidates, choices, new Map());
    return { titles, text: result.text, pending: result.preview.map(row => row.pending) };
  });
  assert.deepEqual(protectedContent.titles, ['範圍  ', '約定 **原文**']);
  assert.deepEqual(protectedContent.pending, [false, true]);
  assert.equal(protectedContent.text,
    '# <!-- md-number:v1:h:g1:1:chapter:1 --> 範圍  \r\n\r\n\t10. code\r\n\r\n## 第十五條約定 **原文**\r\n\r\n' +
    '依照第十五條，保留 \x60x = 2\x60、12.34 元及空格。  \r\n');
  await page.locator('#organize-numbering').click();
  await page.locator('#numbering-settings').waitFor();
  await page.locator('#numbering-options summary').click();
  const basePrompt = await page.locator('#numbering-prompt').inputValue();
  await page.locator('#numbering-prompt').fill('temporary');
  await page.locator('[onclick="restoreNumberingPrompt()"]').click();
  assert.equal(await page.locator('#numbering-prompt').inputValue(), basePrompt);
  await page.locator('#numbering-prompt').fill(basePrompt + '\nPrefer outline numbering for headings.');
  const actions = [];
  let delayResponse;
  let notifyAnalysis;
  let invalidResponse = false;
  await page.route('**/api/numbering', async route => {
    const payload = route.request().postDataJSON();
    actions.push(payload.action);
    if (payload.action !== 'analyze') {
      assert.deepEqual(Object.keys(payload).sort(), ['action', 'model']);
      await route.fulfill({ json: { provider: 'numbering.test', model: 'fixture-model' } });
      return;
    }
    assert.match(payload.prompt, /Prefer outline numbering/);
    assert.ok(!JSON.stringify(payload.candidates).includes('PRIVATE-CODE'));
    assert.ok(!JSON.stringify(payload.candidates).includes('private.example'));
    const id = excerpt => payload.candidates.find(row => row.excerpt.includes(excerpt))?.id;
    const entry = (name, kind, level, anchor, style, review = false) => ({
      id: id(name), kind, level, group: id(anchor), style, start: 0, review
    });
    const items = [
      entry('Scope', 'heading', 1, 'Scope', 'outline'),
      entry('Details', 'heading', 2, 'Scope', 'outline'),
      entry('First', 'ordered', 1, 'First', 'decimal-dot'),
      entry('Second', 'ordered', 1, 'First', 'decimal-dot'),
      entry('Third', 'ordered', 1, 'First', 'decimal-dot'),
      entry('Bullet', 'bullet', 1, 'Bullet', 'diamond'),
      entry('Nested', 'bullet', 2, 'Bullet', 'circle'),
      entry('Notes', 'heading', 1, 'Scope', 'outline'),
      entry('Next', 'heading', 2, 'Scope', 'outline'),
      entry('Compound', 'ordered', 1, 'Compound', 'outline', true)
    ];
    if (delayResponse) {
      notifyAnalysis();
      await delayResponse;
    }
    await route.fulfill({ json: { items: invalidResponse ? [{ ...items[0], rewrittenText: 'forbidden' }] : items } }).catch(() => {});
  });
  await page.locator('#numbering-test').click();
  await page.waitForFunction(() => document.getElementById('numbering-connection-status').textContent.includes('fixture-model'));
  await page.locator('[onclick="saveNumberingSettings()"]').click();
  const original = '# 7. **Scope**\n\n## 7.4 Details\n\n3. First *unchanged*\n4. Second\n\n' +
    '正文金额 12.34 元，保留 [原链接](https://private.example/a)。\n\n' +
    '1. Third\n\n- Bullet\n   - Nested\n\n# 12. Notes\n\n## 12.3 Next\n\n' +
    '1.2.3 Compound\n\n```text\n2. PRIVATE-CODE\n```\n';
  await edit(page, original);
  await page.evaluate(() => { window.print = () => { window.printCount = (window.printCount || 0) + 1; }; });
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.locator('#organize-numbering').click();
  await page.waitForFunction(() => document.querySelector('#preview h2')?.dataset.numberLabel === '1.1');
  assert.equal(await page.locator('#editor').inputValue(), original);
  assert.equal(downloads, 0);
  assert.equal(await page.evaluate(() => window.printCount || 0), 0);
  const labels = await page.locator('#preview [data-number-label]').evaluateAll(nodes => nodes.map(node => node.dataset.numberLabel));
  assert.deepEqual(labels, ['1', '1.1', '1.', '2.', '3.', '◆', '○', '2', '2.1']);
  assert.equal(await page.locator('#preview em').textContent(), 'unchanged');
  assert.equal(await page.locator('#preview a').getAttribute('href'), 'https://private.example/a');
  assert.match(await page.locator('#preview pre').textContent(), /PRIVATE-CODE/);
  assert.match(await page.locator('#numbering-status').textContent(), /1.*待确认/);
  const compoundId = original.split('\n').findIndex(line => line.startsWith('1.2.3')) + 1;
  await page.locator('#numbering-changes summary').click();
  await page.locator('#numbering-choice-' + compoundId).selectOption('use');
  await page.waitForFunction(() => [...document.querySelectorAll('#preview li[data-number-label]')]
    .some(li => li.textContent === 'Compound'));
  await page.locator('#numbering-choice-' + compoundId).selectOption('keep');

  const exportAs = async key => {
    await page.locator('#export-dropdown > button').click();
    await page.locator('#export-menu [data-i18n="' + key + '"]').click();
  };
  const output = await download(page, () => exportAs('exportWord'));
  const files = require('../vendor/fflate.js').unzipSync(output.bytes);
  const xml = name => Buffer.from(files['word/' + name + '.xml']).toString();
  assert.match(xml('numbering'), /<w:lvlText w:val="%1\.%2"\/>/);
  assert.match(xml('numbering'), /<w:pStyle w:val="Heading2"\/>/);
  assert.doesNotMatch(xml('document'), /7\.4 Details|12\.3 Next/);
  const byText = text => {
    const paragraph = [...xml('document').matchAll(/<w:p>.*?<\/w:p>/gs)].find(match => match[0].includes(text))?.[0];
    assert.ok(paragraph, 'Expected Word paragraph containing ' + text);
    return { style: paragraph.match(/<w:pStyle w:val="([^"]+)"/)?.[1], numId: paragraph.match(/<w:numId w:val="(\d+)"/)?.[1] };
  };
  assert.equal(byText('Details').style, 'Heading2');
  assert.ok(byText('Details').numId);
  assert.equal(byText('Details').numId, byText('Next').numId);
  assert.equal(byText('First').numId, byText('Third').numId);
  assert.ok(byText('First').numId);
  assert.ok(byText('Bullet').numId);
  await exportAs('exportPdf');
  await page.waitForFunction(() => window.printCount === 1);
  assert.deepEqual(await page.locator('#pdf-document [data-number-label]').evaluateAll(nodes => nodes.map(node => node.dataset.numberLabel)), labels);
  assert.equal((await page.pdf()).subarray(0, 5).toString(), '%PDF-');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  assert.equal(await page.locator('#editor').inputValue(), original);
  assert.deepEqual(actions, ['test', 'status', 'analyze']);

  await page.locator('#numbering-apply').click();
  const applied = await page.locator('#editor').inputValue();
  assert.match(applied, /md-number:v1/);
  assert.match(applied, /正文金额 12\.34 元，保留 \[原链接\]\(https:\/\/private.example\/a\)。/);
  assert.equal(await page.locator('#numbering-review').isVisible(), false);
  await page.locator('[onclick="undo()"]').click();
  assert.equal(await page.locator('#editor').inputValue(), original);

  invalidResponse = true;
  await page.locator('#organize-numbering').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('结构无效'));
  assert.equal(await page.locator('#editor').inputValue(), original);
  invalidResponse = false;
  let finish;
  delayResponse = new Promise(resolve => { finish = resolve; });
  const inFlight = new Promise(resolve => { notifyAnalysis = resolve; });
  await page.locator('#organize-numbering').click();
  await inFlight;
  await edit(page, original + '\n保留刚刚添加的正文。');
  finish();
  assert.equal(await page.locator('#numbering-review').isVisible(), false);
  assert.match(await page.locator('#preview').textContent(), /保留刚刚添加的正文/);
  assert.equal(downloads, 1);
});

test('offline archive and attachment round-trip', { timeout: 60000 }, async t => {
  const server = await serve();
  t.after(server.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const temp = await mkdtemp(path.join(os.tmpdir(), 'md-offline-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const result = spawnSync(python, ['-m', 'zipfile', '-e', path.join(output, 'markdown-editor-offline.zip'), temp], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const offline = await browser.newContext();
  await offline.route(/^https?:/, route => route.abort());
  const direct = await offline.newPage();
  await direct.goto(require('node:url').pathToFileURL(path.join(temp, 'markdown-editor.html')).href);
  await direct.waitForFunction(() => ready);
  if (await direct.locator('#help-modal .primary').isVisible()) await direct.locator('#help-modal .primary').click();
  await direct.locator('#editor').fill('# Offline\\n\\n$x^2$\\n\\n~~~mermaid\\nflowchart TD\\nA --> B\\n~~~'.replaceAll('\\n','\n'));
  await direct.locator('#preview .katex').waitFor({ timeout: 10000 });
  await direct.locator('#preview .mermaid-diagram').waitFor({ timeout: 10000 });
  await offline.close();

  const { page } = await launchPage(browser, server.url);
  const png = await page.evaluate(() => document.createElement('canvas').toDataURL());
  await edit(page, '![Local](' + png + ')');
  await page.evaluate(() => migrateInlinePictures());
  const initial = await page.evaluate(() => draft.text);
  const large = await page.evaluate(async () => {
    const file = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><!--' +
      'x'.repeat(4 * 1024 * 1024) + '--><rect width="8" height="8"/></svg>'], 'large.svg', { type: 'image/svg+xml' });
    return editorAttachments.put(file);
  });
  assert.match(large, /^attachments\/[a-f0-9]{64}\.svg$/);
  await page.reload();
  await page.waitForFunction(value => ready && draft.text === value, initial);
  assert.equal(await page.evaluate(async source => (await draftStorage.getAttachment(source.split('/')[1])).blob.size, large) > 4 * 1024 * 1024, true);
  await edit(page, '![Local](' + png + ')');
  await page.evaluate(async () => {
    const previous = draftStorage.putAttachment;
    draftStorage.putAttachment = async () => { throw new DOMException('Quota', 'QuotaExceededError'); };
    try { await migrateInlinePictures(); }
    finally { draftStorage.putAttachment = previous; }
  });
  assert.equal(await page.evaluate(() => draft.text), '![Local](' + png + ')');
  await page.evaluate(() => migrateInlinePictures());
  const saved = await page.evaluate(() => draft.text);
  assert.match(saved, /attachments\/[a-f0-9]{64}\.png/);
  await page.reload();
  await page.waitForFunction(value => ready && draft.text === value, saved);
  await page.locator('#preview img').waitFor();
  assert.equal(await page.locator('#preview img').getAttribute('src'), png);
  const bundle = await download(page, () => page.evaluate(() => downloadAttachmentBundle()));
  const inline = await download(page, () => page.evaluate(() => exportFile()));
  assert.equal(inline.bytes.toString(), '![Local](' + png + ')');
  await page.locator('#importFile').setInputFiles({ name: 'bad.zip', mimeType: 'application/zip', buffer: Buffer.from('bad zip') });
  await page.waitForFunction(() => document.querySelector('#toast').textContent === t('draftReadFailed'));
  assert.equal(await page.evaluate(() => draft.text), saved);
  await edit(page, '# Interim');
  await page.locator('#importFile').setInputFiles({ name: '归档.副本.zip', mimeType: 'application/zip', buffer: bundle.bytes });
  await page.waitForFunction(value => draft.text === value && !dirtyDraft(), saved);
  assert.equal(await page.locator('#filename').inputValue(), '归档.副本');
  assert.equal(await page.locator('#preview img').getAttribute('src'), png);
});



test('large preview scheduling, export snapshot, and page layout', { timeout: 60000 }, async t => {
  const server = await serve();
  t.after(server.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page } = await launchPage(browser, server.url);
  await edit(page, '# Previous');
  await page.locator('#preview-pause').click();
  await page.evaluate(() => {
    editor.value = '拼';
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
  });
  assert.equal(await page.evaluate(() => draft.text), '# Previous');
  await page.evaluate(() => {
    editor.value = '拼写';
    editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '拼写' }));
  });
  assert.equal(await page.evaluate(() => draft.text), '拼写');
  await page.evaluate(() => {
    editor.value = '# Latest\n\n' + 'A short sentence.\n\n'.repeat(5000);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return saveToLocal();
  });
  assert.equal(await page.locator('#preview h1').textContent(), 'Previous');
  const latest = await download(page, () => page.evaluate(() => exportFile()));
  assert.match(latest.bytes.toString(), /^# Latest/);
  await page.locator('#preview-pause').click();
  await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Latest');

  await page.route('**/slow-image.png', async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.fulfill({ status: 404, body: 'not found' });
  });
  await edit(page, '# Frozen revision\n\n![Missing](/slow-image.png)');
  await page.evaluate(() => { void exportHTML(); });
  await page.locator('#export-check').waitFor();
  await page.evaluate(() => commitDraft('# Later revision'));
  await page.waitForFunction(() => !document.querySelector('#export-continue').disabled);
  const html = await download(page, () => page.locator('#export-continue').click());
  assert.match(html.bytes.toString(), /Frozen revision/);
  assert.doesNotMatch(html.bytes.toString(), /Later revision/);

  await page.evaluate(() => {
    document.querySelector('#export-paper').value = 'A4';
    document.querySelector('#export-margin').value = '19';
    window.print = () => { window.printCalled = true; };
    void exportPDF();
  });
  await page.waitForFunction(() => window.printCalled);
  const pdf = (await page.pdf({ preferCSSPageSize: true })).toString('latin1');
  assert.match(pdf, /\/MediaBox\s*\[0 0 59[45](?:\.\d+)? 84[12](?:\.\d+)?\]/);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  const word = await download(page, () => page.evaluate(() => exportWord()));
  const checked = await page.evaluate(bytes => {
    const files = fflate.unzipSync(new Uint8Array(bytes));
    return new TextDecoder().decode(files['word/document.xml']);
  }, Array.from(word.bytes));
  assert.match(checked, /w:w="11906"/);
  assert.match(checked, /w:top="1077"/);

  await edit(page, '# Cancel\n\n![Missing](/slow-image.png)');
  await page.evaluate(() => { void exportHTML(); });
  await page.locator('#export-check').waitFor();
  await page.locator('[onclick="cancelExportCheck()"]').click();
  await page.waitForFunction(() => exportCheck === null);

  await edit(page, '# Split\n\n' + 'A line for the printed artwork.\n\n'.repeat(65));
  await page.locator('#filename').fill('分片.示例');
  await page.evaluate(() => {
    openExportImageModal();
    document.querySelector('#png-split').checked = true;
    selectImageRatio('1:1');
  });
  await page.waitForFunction(() => imagePages.length > 1, null, { timeout: 20000 });
  const heights = await page.evaluate(async () => Promise.all(imagePages.map(async url => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image.naturalHeight;
  })));
  assert.ok(heights.slice(0,-1).every(height => height === 1080));
  assert.ok(heights.at(-1) > 0 && heights.at(-1) <= 1080);
  const zip = await download(page, () => page.evaluate(() => downloadExportImage()));
  assert.equal(zip.name, '分片.示例.zip');
  const names = await page.evaluate(bytes => Object.keys(fflate.unzipSync(new Uint8Array(bytes))), Array.from(zip.bytes));
  assert.equal(names.length, heights.length);
  assert.equal(names[0], '分片.示例-001.png');
});



test('heading outline follows numbering preview, review, apply and undo', { timeout: 45000 }, async t => {
  const server = await serve();
  t.after(server.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page } = await launchPage(browser, server.url, true);
  const outline = page.locator('#outline-button');
  const source = page.getByLabel('大纲来源');
  const list = page.locator('#outline-list');
  const jump = page.locator('#outline-jump');
  const editor = page.locator('#editor');
  const entries = () => list.locator('option').evaluateAll(options => options.map(option => option.textContent.trim()));

  await page.locator('#organize-numbering').click();
  await page.locator('[onclick="saveNumberingSettings()"]').click();
  let finishAnalysis;
  let startAnalysis;
  const started = new Promise(resolve => { startAnalysis = resolve; });
  const analysis = new Promise(resolve => { finishAnalysis = resolve; });
  await page.route('**/api/numbering', async route => {
    const payload = route.request().postDataJSON();
    if (payload.action !== 'analyze') {
      await route.fulfill({ json: { provider: 'numbering.test', model: 'fixture-model' } });
      return;
    }
    startAnalysis();
    await analysis;
    const id = title => payload.candidates.find(row => row.excerpt === title).id;
    const heading = (title, level) => ({
      id: id(title), kind: 'heading', level, group: id('Start'), style: 'outline', start: 0, review: false
    });
    await route.fulfill({ json: { items: [heading('Start', 1), heading('Target', 2), heading('Candidate', 2)] } });
  });
  const original = '# 9. Start\n\n' + 'Wrapped content '.repeat(600) +
    '\n\n<h2>HTML heading</h2>\n\n## 9.4 Target\n\n7. Candidate\n\n' + 'More content '.repeat(500);
  await edit(page, original);
  await page.locator('#organize-numbering').click();
  await started;
  await outline.click();
  assert.equal(await source.inputValue(), 'original');
  assert.equal(await source.isDisabled(), true);
  assert.deepEqual(await entries(), ['9. Start · 1', '9.4 Target · 7']);
  finishAnalysis();
  await page.waitForFunction(() => document.querySelector('#outline-source').value === 'preview');
  assert.deepEqual((await entries()).slice(0, 3), ['1 Start', 'HTML heading', '1.1 Target']);
  await list.selectOption({ label: '   1.1 Target' });
  await jump.click();
  await page.waitForFunction(() => {
    const pane = document.querySelector('#preview');
    const heading = pane.querySelector('h2[data-number-label="1.1"]');
    return pane.scrollTop > 0 && Math.abs(heading.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12) < 2;
  });
  assert.equal(await editor.inputValue(), original);

  await page.locator('#numbering-changes summary').click();
  const candidateLine = original.split('\n').findIndex(line => line.startsWith('7. Candidate')) + 1;
  const candidate = page.locator('#numbering-choice-' + candidateLine);
  await candidate.selectOption('heading');
  await page.locator('#editor-collapse-btn').click();
  assert.equal(await outline.isEnabled(), true);
  await outline.click();
  assert.equal(await source.inputValue(), 'preview');
  assert.ok((await entries()).some(entry => entry.endsWith(' Candidate')));
  await source.selectOption('original');
  assert.deepEqual(await entries(), ['9. Start · 1', '9.4 Target · 7']);
  await list.selectOption('1');
  await list.press('Enter');
  assert.equal(await editor.isVisible(), true);
  assert.equal(await editor.evaluate(el => el.selectionStart), original.indexOf('## 9.4 Target'));
  assert.ok(await editor.evaluate(el => el.scrollTop > 100));
  assert.equal(await editor.inputValue(), original);

  await page.locator('#numbering-apply').click();
  await outline.click();
  assert.equal(await source.inputValue(), 'original');
  assert.equal(await source.isDisabled(), true);
  assert.ok((await entries()).includes('1.1 Target · 7'));
  assert.ok((await entries()).some(entry => entry.endsWith(' Candidate · ' + candidateLine)));
  await page.keyboard.press('Escape');
  await page.locator('[onclick="undo()"]').click();
  await outline.click();
  assert.deepEqual(await entries(), ['9. Start · 1', '9.4 Target · 7']);
});

test('workspace and writing tools in Chromium and Firefox', { timeout: 90000 }, async t => {
  const server = await serve();
  t.after(server.close);
  for (const engine of [chromium, firefox]) {
    await t.test(engine.name(), async sub => {
      const browser = await engine.launch();
      sub.after(() => browser.close());
      const { context, page } = await launchPage(browser, server.url, true);
      await page.setViewportSize({ width: 390, height: 844 });
      const text = '# 中文\n\n## Repeat\n\n~~~md\n# Ignored\n~~~\n\n## Repeat\n\nSetext\n------\n\nalpha alpha';
      await edit(page, text);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
      const toolbar = page.locator('.editor-toolbar');
      const controls = toolbar.locator('[onclick="undo()"], #outline-button, [onclick="openTemplates()"]');
      assert.equal(await controls.count(), 3);
      assert.ok(await controls.evaluateAll(buttons => {
        const centers = buttons.map(button => {
          const { top, height } = button.getBoundingClientRect();
          return top + height / 2;
        });
        return Math.max(...centers) - Math.min(...centers) < 1;
      }));
      await page.locator('[onclick="openOutline()"]').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#outline-list option').count(), 4);
      await page.locator('#outline-list').selectOption('2');
      await page.locator('#outline-list').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#editor').evaluate(el => el.selectionStart), text.lastIndexOf('## Repeat'));
      await page.locator('[onclick="openTemplates()"]').click();
      assert.match(await page.locator('#template-content').inputValue(), /^# 项目名称\n\n## 简介/);
      await page.locator('#template-list').selectOption('technical');
      assert.match(await page.locator('#template-content').inputValue(), /^# 技术文档\n\n## 背景/);
      await page.locator('#template-list').selectOption('meeting');
      const preview = await page.locator('#template-content').inputValue();
      assert.equal(preview, '# 会议纪要\n\n## 议程\n\n## 决定\n\n## 行动事项\n\n');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => draft.text), text);
      const selected = text.lastIndexOf('alpha');
      await page.locator('#editor').evaluate((el, start) => el.setSelectionRange(start, start + 5), selected);
      await page.locator('[onclick="openTemplates()"]').click();
      await page.locator('#template-modal [data-i18n="insert"]').click();
      assert.equal(await page.locator('#editor').inputValue(), text.slice(0, selected) + '\n\n' + preview);
      assert.equal(await page.locator('#preview h1').last().textContent(), '会议纪要');
      await page.evaluate(() => undo());
      assert.equal(await page.evaluate(() => draft.text), text);

      await page.evaluate(() => openFindModal());
      await page.locator('#find-input').fill('alpha');
      await page.locator('#replace-input').fill('beta');
      await page.locator('[onclick="previewReplaceAll()"]').click();
      assert.equal(await page.evaluate(() => draft.text), text);
      assert.ok((await page.locator('#replace-preview').inputValue()).includes('beta'));
      await page.locator('#apply-replace-all').click();
      assert.match(await page.evaluate(() => draft.text), /beta beta$/);
      await page.keyboard.press('Escape');
      await page.evaluate(() => undo());
      assert.equal(await page.evaluate(() => draft.text), text);

      await page.evaluate(() => saveToLocal());
      await page.locator('[onclick="openWorkspace()"]').click();
      await page.waitForFunction(() => document.querySelector('#workspace-list').options.length === 1);
      await page.locator('#workspace-tags').fill('fixture,测试');
      await page.locator('[onclick="saveWorkspaceTags()"]').click();
      await page.waitForFunction(() => !dirtyDraft() && draft.tags.includes('测试'));
      await page.locator('[onclick="newWorkspaceDocument()"]').click();
      await page.waitForFunction(() => draft.id !== draftStorage.defaultId);
      const newId = await page.evaluate(() => draft.id);
      await edit(page, '# Second document');
      const png = await page.evaluate(() => document.createElement('canvas').toDataURL());
      await page.evaluate(async value => {
        const attachment = await editorAttachments.put(await (await fetch(value)).blob());
        commitDraft(draft.text + '\n\n![Image](' + attachment + ')');
        await saveToLocal();
      }, png);
      const secondText = await page.evaluate(() => draft.text);
      await page.locator('[onclick="openWorkspace()"]').click();
      await page.locator('#workspace-search').fill('beta beta');
      await page.locator('#workspace-search').fill('alpha alpha');
      await page.waitForFunction(() => document.querySelector('#workspace-list').options.length === 1);
      await page.locator('[onclick="selectWorkspaceDocument()"]').click();
      await page.waitForFunction(() => draft.id === draftStorage.defaultId);
      assert.equal(await page.evaluate(() => draft.text), text);
      const parallel = await context.newPage();
      await parallel.goto(server.url);
      await parallel.waitForFunction(() => ready);
      await parallel.evaluate(id => switchWorkspaceDocument(() => draftStorage.read(id)), newId);
      await edit(page, text + '\n\nDocument one update');
      await edit(parallel, secondText + '\n\nDocument two update');
      assert.equal(await page.evaluate(() => saveStatus), 'autosaveEnabled');
      assert.equal(await parallel.evaluate(() => saveStatus), 'autosaveEnabled');
      await parallel.close();

      await page.locator('[onclick="openWorkspace()"]').click();
      const backup = await download(page, () => page.locator('[onclick="downloadWorkspace()"]').click());
      const empty = await launchPage(browser, server.url, true);
      const emptyPage = empty.page;
      await emptyPage.locator('[onclick="openWorkspace()"]').click();
      await emptyPage.locator('#workspace-restore-file').setInputFiles({ name: backup.name, mimeType: 'application/zip', buffer: backup.bytes });
      await emptyPage.waitForFunction(() => document.querySelector('#workspace-status').textContent === t('workspaceRestored', 2));
      const restored = await emptyPage.evaluate(() => draftStorage.workspaceSnapshot());
      assert.equal(restored.length, 2);
      assert.ok(restored.some(entry => entry.tags.includes('测试') && entry.history.length > 0));
      const archiveText = restored.find(entry => entry.id === newId).text;
      const actual = await emptyPage.evaluate(text => editorAttachments.resolve(text), archiveText);
      assert.ok(actual.text.includes(png));
      const before = await emptyPage.evaluate(() => draftStorage.documents());
      await emptyPage.locator('#workspace-restore-file').setInputFiles({ name: 'malformed.zip', mimeType: 'application/zip', buffer: Buffer.from('invalid') });
      await emptyPage.waitForFunction(() => document.querySelector('#workspace-status').textContent === t('workspaceError'));
      assert.deepEqual(await emptyPage.evaluate(() => draftStorage.documents()), before);
      await empty.context.close();
      await context.close();
    });
  }
});


