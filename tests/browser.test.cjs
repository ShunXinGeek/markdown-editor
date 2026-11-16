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

function assertWordListIndent(paragraph) {
  const [, left, hanging] = paragraph.match(/<w:ind w:left="(\d+)" w:hanging="(\d+)"\/>/) || [];
  assert.ok(Number(hanging) > 0, 'Expected a hanging indent in the Word list paragraph');
  assert.equal(left, hanging);
  assert.match(paragraph, new RegExp(`<w:tab w:val="left" w:pos="${left}"/>`));
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
      assert.equal((await page.locator('#preview li').first().textContent()).trim(), 'Heading');
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
    assert.match(html.bytes.toString(), /<li>Export fixture<\/li>/);
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
  assert.equal(await page.locator('#preview > div > p').first().textContent(), 'A. Smith wrote this.');
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
  const content = await editor.inputValue();
  const withHeadings = content + '\n\n' + Array.from({ length: 6 }, (_, i) => '#'.repeat(i + 1) + ' Title ' + (i + 1)).join('\n\n');
  await edit(page, withHeadings);
  const fontSizes = scope => page.locator(scope + ' .markdown-body, ' + scope + ' .markdown-body li')
    .evaluateAll(nodes => nodes.map(node => Number.parseFloat(getComputedStyle(node).fontSize)));
  const defaultSizes = await fontSizes('#preview');
  assert.ok(defaultSizes.length >= 7 && defaultSizes.every(size => size === 16));
  await page.evaluate(() => {
    localStorage.setItem('md_editor_font_sizes', JSON.stringify({ body: 15, h2: 18 }));
    return saveToLocal();
  });
  await page.reload();
  await page.waitForFunction(() => ready && renderedPreviewText === draft.text);
  assert.deepEqual(await fontSizes('#preview'), defaultSizes);
  assert.equal(await page.locator('#font-size-toggle').count(), 0);
  assert.equal(await root.evaluate(el => getComputedStyle(el).fontFamily), '"Times New Roman", sans-serif');
  const html = await download(page, () => exportAs('exportHtml'));
  const exported = await context.newPage();
  await exported.setContent(html.bytes.toString(), { waitUntil: 'domcontentloaded' });
  const savedList = exported.locator('ol[data-list-style="decimal-parens"]').first();
  assert.equal(await savedList.evaluate(el => getComputedStyle(el).listStyleType), 'md-list-decimal-parens');
  assert.equal(await savedList.evaluate(el => getComputedStyle(el).fontFamily), '"Times New Roman", sans-serif');
  assert.equal(await exported.locator('body').evaluate(el => getComputedStyle(el).fontSize), '16px');
  assert.equal(await savedList.evaluate(el => getComputedStyle(el).fontSize), '16px');
  await exported.close();
  const md = await download(page, () => exportAs('exportMd'));
  assert.equal(md.bytes.toString(), await editor.inputValue());

  const word = await download(page, () => exportAs('exportWord'));
  const files = require('../vendor/fflate.js').unzipSync(word.bytes);
  const xml = name => Buffer.from(files[`word/${name}.xml`]).toString();
  assert.match(xml('styles'), /w:eastAsia="Times New Roman"/);
  assert.match(xml('styles'), /<w:rPrDefault>.*?<w:sz w:val="24".*?<\/w:rPrDefault>/s);
  assert.doesNotMatch(xml('document'), /<w:pStyle w:val="Heading/);
  const listLevels = [...xml('numbering').matchAll(/<w:lvl\b[^>]*>(.*?)<\/w:lvl>/g)]
    .map(match => match[1]).filter(level => level.includes('<w:suff w:val="tab"/>'));
  assert.ok(listLevels.length >= 3 && listLevels.every(level => level.includes('<w:lvlJc w:val="left"/>')));
  for (const paragraph of xml('document').match(/<w:p>.*?<\/w:p>/gs).filter(p => p.includes('<w:numPr>'))) {
    assertWordListIndent(paragraph);
  }
  assert.match(xml('numbering'), /w:numFmt w:val="chineseLegalSimplified"/);
  assert.match(xml('numbering'), /w:numFmt w:val="upperLetter"/);
  assert.match(xml('numbering'), /w:lvlText w:val="\(%3\)"/);
  const wordLists = [...xml('document').matchAll(/<w:ilvl w:val="([0-2])"\/><w:numId w:val="(\d+)"\/>/g)];
  assert.deepEqual([...new Set(wordLists.map(match => match[1]))], ['0', '1', '2']);
  assert.equal(new Set(wordLists.slice(0, 8).map(match => match[2])).size, 1);
  assert.doesNotMatch(xml('document'), /壹、甲|A\. 字母甲|\(1\) 插入/);

  await page.evaluate(() => { window.print = () => { window.printCalled = true; }; });
  await exportAs('exportPdf');
  await page.waitForFunction(() => window.printCalled);
  assert.equal(await page.locator('#pdf-document .markdown-body').evaluate(el => getComputedStyle(el).fontFamily),
    '"Times New Roman", sans-serif');
  assert.deepEqual(await fontSizes('#pdf-document'), defaultSizes);
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
      await route.fulfill({ json: { items: [{ id, kind: 'ordered', level: 1, group: id,
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

test('HTTPS editor uses the same-origin Netlify function and applies a cross-batch preview', { timeout: 30000 }, async t => {
  const server = await serve();
  t.after(server.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('md_editor_help_shown', 'true'));
  const origin = 'https://editor.example';
  const { default: numbering } = await import('../netlify/functions/numbering.mjs');
  const actions = [];
  const upstreamCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const { messages } = JSON.parse(options.body);
    const { candidates, previous } = JSON.parse(messages[1].content);
    upstreamCalls.push({ size: candidates.length, previous });
    const group = previous?.[0]?.group ?? candidates[0].id;
    let items = candidates.map(row => ({ id: row.id, kind: 'ordered', level: row.depth || 1,
      group, style: 'outline', start: 0, review: false }));
    if (candidates[0].excerpt === '定义') {
      assert.match(messages[0].content, /「1\. 定义」是 ordered 第 1 级/);
      assert.equal(candidates[0].headingLevel, 0);
      assert.equal(candidates[1].prefix, '1.1');
      // Return the reported misclassification and also cover an omitted child.
      items = [
        { ...items[0], level: 1, style: 'decimal-dot' },
        ...(candidates[0].id === 1 ? [{ ...items[1], kind: 'ordered', level: 1, group: items[1].id }] : []),
        ...items.slice(2).map(item => ({ ...item, kind: 'ordered', level: 3, style: 'decimal-parens' }))
      ];
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items }) } }] });
  });
  await context.route(`${origin}/**`, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname !== '/api/numbering') {
      const response = await route.fetch({ url: new URL(pathname, server.url).href });
      return route.fulfill({ response });
    }
    actions.push(request.postDataJSON().action);
    const response = await numbering(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: request.postData()
    }));
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => ready);

  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模型设置' });
  await dialog.getByRole('button', { name: '测试连接' }).click();
  assert.match(await dialog.getByRole('status').textContent(), /请选择模型供应商/);
  await dialog.getByLabel('模型供应商').selectOption('deepseek');
  await dialog.getByLabel('API Key').fill('fixture-key');
  await dialog.getByLabel('模型名称').fill('fixture-model');
  await dialog.getByRole('button', { name: '测试连接' }).click();
  await dialog.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('md_editor_numbering_settings').includes('fixture-key')), false);

  const original = ['# 9. Chapter', ...Array.from({ length: 41 }, (_, index) => `## 9.9 Section ${index + 1}`)].join('\n\n');
  await edit(page, original);
  const organize = page.locator('#organize-numbering');
  page.once('dialog', dialog => dialog.dismiss());
  await organize.click();
  await page.locator('#numbering-review').waitFor({ state: 'hidden' });
  assert.deepEqual(actions, ['test', 'status']);
  assert.equal(upstreamCalls.length, 1);

  page.once('dialog', dialog => dialog.accept());
  await organize.click();
  await page.locator('#numbering-apply').waitFor();
  assert.deepEqual(actions, ['test', 'status', 'status', 'analyze', 'analyze']);
  assert.deepEqual(upstreamCalls.map(({ size }) => size), [1, 40, 2]);
  assert.equal(upstreamCalls[2].previous[0].group, 1);
  assert.equal(upstreamCalls[2].previous[1].excerpt, 'Section 39');
  assert.equal(await page.locator('#preview [data-number-label]').last().getAttribute('data-number-label'), '1.41');
  assert.equal(await page.locator('#editor').inputValue(), original);
  await page.locator('#numbering-apply').click();
  assert.notEqual(await page.locator('#editor').inputValue(), original);
  await page.locator('[onclick="undo()"]').click();
  assert.equal(await page.locator('#editor').inputValue(), original);

  const clauses = [
    '1. 定义',
    '1.1. 除上下文另有规定外,下列词语和表述应具有本条款赋予它们的含义:',
    '(1)"附属公司"就某公司而言,指的是(1)该公司的直接或间接子公司,或(2)该公司的直接或间接控股公司,或(3)该控股公司(不包括该公司)的直接或间接子公司。',
    '(2)"附属公司"须据此诠释,而"控股公司"及"附属公司"则分别具有《公司条例》(第622章)第13及15条所赋予的含义。',
    '(3)"协议"指本联营体经营协议及双方根据第37条不时商定的修订(如有)。',
    '(4)"资金通知”指联营体董事会向各方发出的通知,以根据第11条的规定向各方催缴营运资金。"CEO"指一方的CEO或董事总经理或类似级别的官员。',
    '(5)“投标条件”系指业主对提交投标书的要求。'
  ].join('\n');
  for (const source of [clauses, '\n' + clauses.replace('1.', '1\\.')]) {
    await edit(page, source);
    page.once('dialog', dialog => dialog.accept());
    await organize.click();
    await page.locator('#numbering-apply').waitFor();
    const preview = page.locator('#preview .markdown-body');
    const first = preview.locator(':scope > ol > li[data-number-label="1."]');
    const second = first.locator(':scope > ol > li[data-number-label="1.1"]');
    assert.match(await first.textContent(), /^\s*定义/);
    assert.match(await second.textContent(), /^\s*除上下文另有规定外/);
    assert.deepEqual(await second.locator(':scope > ol > li').evaluateAll(nodes => nodes.map(node => node.dataset.numberLabel)),
      ['(1)', '(2)', '(3)', '(4)', '(5)']);
    assert.equal(await preview.locator('h1,h2').count(), 0);
    assert.equal(await page.locator('#editor').inputValue(), source);
  }
});

test('numbering suggestions can be reopened and edited by level while exports remain manual', { timeout: 90000 }, async t => {
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
    const choices = editorNumbering.decisions(candidates, { items: candidates.slice(0, 2).map((candidate, index) => ({
      id: candidate.id, kind: 'ordered', group: candidates[0].id, level: index + 1,
      style: 'auto', start: 0, review: false
    })) });
    const result = editorNumbering.patch(original, candidates, choices, new Map());
    return { titles, text: result.text, pending: result.preview.map(row => row.pending) };
  });
  assert.deepEqual(protectedContent.titles, ['範圍  ', '約定 **原文**']);
  assert.deepEqual(protectedContent.pending, [false, true]);
  assert.equal(protectedContent.text,
    '1. <!-- md-number:v1:o:g1:1:chapter:1 --> 範圍  \r\n\r\n\t10. code\r\n\r\n## 第十五條約定 **原文**\r\n\r\n' +
    '依照第十五條，保留 \x60x = 2\x60、12.34 元及空格。  \r\n');
  await page.locator('#organize-numbering').click();
  await page.locator('#numbering-settings').waitFor();
  await page.locator('#numbering-options summary').click();
  const basePrompt = await page.locator('#numbering-prompt').inputValue();
  await page.locator('#numbering-prompt').fill('temporary');
  await page.locator('[onclick="restoreNumberingPrompt()"]').click();
  assert.equal(await page.locator('#numbering-prompt').inputValue(), basePrompt);
  await page.locator('#numbering-prompt').fill(basePrompt + '\nPrefer outline numbering for ordered lists.');
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
      entry('Scope', 'ordered', 1, 'Scope', 'outline'),
      entry('Details', 'ordered', 2, 'Scope', 'outline'),
      entry('First', 'ordered', 1, 'First', 'decimal-dot'),
      entry('Second', 'ordered', 1, 'First', 'decimal-dot'),
      entry('Third', 'ordered', 1, 'First', 'decimal-dot'),
      entry('Bullet', 'bullet', 1, 'Bullet', 'diamond'),
      entry('Nested', 'bullet', 2, 'Bullet', 'circle'),
      entry('Notes', 'ordered', 1, 'Scope', 'outline'),
      entry('Next', 'ordered', 2, 'Scope', 'outline'),
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
  await page.waitForFunction(() => document.querySelector('#preview li[data-number-label="1.1"]'));
  assert.equal(await page.locator('#editor').inputValue(), original);
  assert.equal(downloads, 0);
  assert.equal(await page.evaluate(() => window.printCount || 0), 0);
  const labels = await page.locator('#preview [data-number-label]').evaluateAll(nodes => nodes.map(node => node.dataset.numberLabel));
  assert.deepEqual(labels, ['1', '1.1', '1.', '2.', '3.', '◆', '○', '2', '2.1']);
  assert.equal(await page.locator('#preview em').textContent(), 'unchanged');
  assert.equal(await page.locator('#preview a').getAttribute('href'), 'https://private.example/a');
  assert.match(await page.locator('#preview pre').textContent(), /PRIVATE-CODE/);
  assert.match(await page.locator('#numbering-status').textContent(), /1.*待确认/);
  const panel = page.locator('#numbering-review');
  const previewPane = page.locator('#preview');
  const togglePanel = page.locator('#numbering-toggle');
  const resizer = page.locator('#numbering-resizer');
  assert.equal(await panel.evaluate(el => !!el.previousElementSibling?.matches('.main')), true);
  assert.equal(await page.locator('#preview-pane #numbering-review, .preview-pane #numbering-review').count(), 0);
  const initial = await panel.boundingBox();
  const handle = await resizer.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 48);
  await page.mouse.up();
  const enlarged = await panel.boundingBox();
  const previewBounds = await previewPane.boundingBox();
  assert.ok(enlarged.height > initial.height && previewBounds.height > 100);
  assert.ok(previewBounds.y + previewBounds.height <= enlarged.y + 1);

  const orderedTwo = page.locator('#numbering-style-ordered-2');
  await orderedTwo.selectOption('decimal-wide');
  assert.deepEqual(await page.locator('#preview li[data-number-label="（1）"]').evaluateAll(nodes => nodes.map(node => node.dataset.numberLabel)), ['（1）', '（1）']);
  await page.locator('#numbering-collapse').click();
  assert.equal(await panel.isVisible(), false);
  assert.equal(await togglePanel.getAttribute('aria-expanded'), 'false');
  assert.ok(await page.locator('#preview li[data-number-label="（1）"]').first().isVisible());
  await togglePanel.click();
  assert.equal(await orderedTwo.inputValue(), 'decimal-wide');
  assert.deepEqual(actions, ['test', 'status', 'analyze']);
  await orderedTwo.selectOption('');

  const compoundId = original.split('\n').findIndex(line => line.startsWith('1.2.3')) + 1;
  await page.locator('button[aria-controls="numbering-lines-ordered-1"]').click();
  await page.locator('#numbering-choice-' + compoundId).selectOption('use');
  assert.ok(await page.locator('#preview li[data-number-label]').evaluateAll(items =>
    items.some(li => li.textContent.trim() === 'Compound')), await page.locator('#numbering-status').textContent());
  await page.locator('#numbering-choice-' + compoundId).selectOption('keep');
  const orderedOne = page.locator('#numbering-style-ordered-1');
  await orderedOne.selectOption('decimal-wide');
  assert.deepEqual(await page.locator('#preview li[data-number-label]').evaluateAll(nodes => nodes.map(node => node.dataset.numberLabel)),
    ['（1）', '1.1', '（1）', '（2）', '（3）', '◆', '○', '（2）', '2.1']);
  assert.equal(await page.locator('#numbering-choice-' + compoundId).inputValue(), 'keep');
  assert.match(await page.locator('#numbering-choice-' + compoundId).locator('..').textContent(), /手动选择/);
  await orderedOne.selectOption('');

  const exportAs = async key => {
    await page.locator('#export-dropdown > button').click();
    await page.locator('#export-menu [data-i18n="' + key + '"]').click();
    assert.match(await page.locator('#export-check-status').filter({ hasText: '多级编号无法与上下文连续衔接' }).textContent(), /按原文保留/);
    await page.locator('#export-continue').click();
  };
  const output = await download(page, () => exportAs('exportWord'));
  const files = require('../vendor/fflate.js').unzipSync(output.bytes);
  const xml = name => Buffer.from(files['word/' + name + '.xml']).toString();
  assert.match(xml('numbering'), /<w:lvlText w:val="%1\.%2"\/>/);
  assert.doesNotMatch(xml('numbering'), /<w:pStyle w:val="Heading/);
  assert.doesNotMatch(xml('document'), /7\.4 Details|12\.3 Next/);
  const byText = text => {
    const paragraph = [...xml('document').matchAll(/<w:p>.*?<\/w:p>/gs)].find(match => match[0].includes(text))?.[0];
    assert.ok(paragraph, 'Expected Word paragraph containing ' + text);
    return { style: paragraph.match(/<w:pStyle w:val="([^"]+)"/)?.[1], numId: paragraph.match(/<w:numId w:val="(\d+)"/)?.[1] };
  };
  assert.equal(byText('Details').style, 'ListParagraph');
  assert.ok(byText('Details').numId);
  assert.equal(byText('Details').numId, byText('Next').numId);
  assert.equal(byText('First').numId, byText('Third').numId);
  assert.ok(byText('First').numId);
  assert.ok(byText('Bullet').numId);
  const preserved = xml('document').match(/<w:p>.*?<\/w:p>/gs).find(p => p.includes('Compound'));
  assert.match(preserved, />1\.2\.3<\/w:t><w:tab\/>/);
  assertWordListIndent(preserved);
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
  assert.equal(await page.locator('#numbering-review').isVisible(), true);
  assert.match(await page.locator('#numbering-status').textContent(), /已应用/);
  assert.equal(await page.locator('#numbering-apply').isVisible(), false);
  await page.locator('#numbering-undo').click();
  assert.equal(await page.locator('#editor').inputValue(), original);
  assert.match(await page.locator('#numbering-status').textContent(), /已撤回/);

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
  assert.match(await page.locator('#numbering-status').textContent(), /原文已变化/);
  assert.equal(await page.locator('#numbering-apply').isVisible(), false);
  assert.match(await page.locator('#preview').textContent(), /保留刚刚添加的正文/);
  assert.equal(downloads, 1);
});

test('long numbering continues list levels across batches', { timeout: 45000 }, async t => {
  const server = await serve();
  t.after(server.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page } = await launchPage(browser, server.url, true);
  await page.locator('#organize-numbering').click();
  await page.locator('[onclick="saveNumberingSettings()"]').click();

  const original = ['# 9. Chapter A',
    ...Array.from({ length: 238 }, (_, i) => '## 9.9 Section ' + (i + 1)),
    '### 9.9.9 Detail A', '### 9.9.9 Detail B', '## 9.9 Closing section',
    '# 20. Chapter B', '## 20.9 Chapter B section',
    Array.from({ length: 238 }, (_, i) => '1. Item ' + (i + 1)).join('\n'),
    '# 31. Chapter C', '## 31.9 Chapter C section'].join('\n\n');
  await edit(page, original);
  const batches = [];
  let statuses = 0;
  let confirmations = 0;
  let failLaterBatch = true;
  page.on('dialog', dialog => { if (dialog.type() === 'confirm') confirmations++; });
  await page.route('**/api/numbering', async route => {
    const { action, candidates, previous } = route.request().postDataJSON();
    if (action === 'status') {
      statuses++;
      await route.fulfill({ json: { provider: 'numbering.test', model: 'fixture-model' } });
      return;
    }
    batches.push({ size: candidates.length, path: previous?.map(row => [row.kind, row.level, row.excerpt]) });
    if (previous) {
      assert.equal(await page.locator('#preview [data-number-label]').count(), 0);
      assert.equal(await page.locator('#numbering-apply').isVisible(), false);
      assert.match(await page.locator('#numbering-status').textContent(), /第 [23] 批，共 3 批/);
      if (failLaterBatch) {
        await route.fulfill({ status: 502, json: { error: 'Fixture failure' } });
        return;
      }
    }
    const anchor = previous?.[0]?.group ?? candidates[0].id;
    const itemsGroup = previous?.find(row => row.excerpt.startsWith('Item '))?.group ??
      candidates.find(row => row.excerpt.startsWith('Item '))?.id;
    await route.fulfill({ json: { items: candidates.map(candidate => {
      const { id, kind, depth, excerpt } = candidate;
      const plainSeries = excerpt.startsWith('Item ');
      const finalSeries = excerpt.startsWith('Chapter C');
      const changedStyle = excerpt === 'Detail B';
      return { id, kind, level: depth || 1, group: plainSeries ? itemsGroup : finalSeries ? candidates.find(row => row.excerpt === 'Chapter C').id : anchor,
        style: !plainSeries && !changedStyle ? 'outline' : 'decimal-dot',
        start: changedStyle ? 99 : 0, review: false };
    }).reverse() } });
  });

  await page.locator('#organize-numbering').click();
  await page.locator('#toast.show').filter({ hasText: '模型调用失败' }).waitFor();
  assert.equal(await page.locator('#numbering-review').isVisible(), false);
  assert.equal(await page.locator('#editor').inputValue(), original);
  assert.deepEqual(batches.map(batch => batch.size), [240, 240]);

  failLaterBatch = false;
  batches.length = 0;
  await page.locator('#organize-numbering').click();
  await page.locator('#numbering-apply').waitFor();
  assert.equal(statuses, 2);
  assert.equal(confirmations, 2);
  assert.deepEqual(batches, [
    { size: 240, path: undefined },
    { size: 240, path: [['ordered', 1, 'Chapter A'], ['ordered', 2, 'Section 238'], ['ordered', 3, 'Detail A']] },
    { size: 4, path: [['ordered', 1, 'Item 236']] }
  ]);
  const labels = page.locator('#preview [data-number-label]');
  const expected = ['1', ...Array.from({ length: 238 }, (_, i) => '1.' + (i + 1)),
    '1.238.1', '1.238.2', '1.239', '2', '2.1', ...Array.from({ length: 238 }, (_, i) => (i + 1) + '.'), '1', '1.1'];
  const verifyLabels = async () => {
    assert.deepEqual(await labels.evaluateAll(nodes => nodes.map(node => node.dataset.numberLabel)), expected);
    assert.equal((await page.locator('#preview li[data-number-label="1.238.2"]').textContent()).trim(), 'Detail B');
  };
  await verifyLabels();
  assert.equal(await page.locator('#editor').inputValue(), original);
  await page.locator('#numbering-apply').click();
  await page.waitForFunction(() => document.querySelectorAll('#preview [data-number-label]').length === 484);
  await verifyLabels();
  await page.locator('[onclick="undo()"]').click();
  assert.equal(await page.locator('#editor').inputValue(), original);
});

test('plain text stays out of cross-batch numbering and dependent invalid groups stay pending', { timeout: 45000 }, async t => {
  const server = await serve();
  t.after(server.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page } = await launchPage(browser, server.url, true);
  await page.locator('#organize-numbering').click();
  await page.locator('[onclick="saveNumberingSettings()"]').click();

  const lines = Array(128).fill('');
  lines.fill('- 其他条目', 0, 79);
  lines.fill('- 备用条目', 92, 127);
  const sample = { 85: '5. 第五章', 87: '5.2. 本批第一条', 88: '5.3. 上一条', 90: '投标费用',
    91: '5.4. 本批后续条目', 92: '   - 依赖第 90 行的条目', 128: '5.5. 下一批条目' };
  for (const [id, line] of Object.entries(sample)) lines[id - 1] = line;
  const original = lines.join('\n');
  await edit(page, original);

  const decisions = [
    { id: 85, kind: 'ordered', level: 1, group: 85, style: 'decimal-dot', start: 5, review: false },
    { id: 87, kind: 'ordered', level: 2, group: 85, style: 'outline', start: 2, review: false },
    { id: 88, kind: 'ordered', level: 2, group: 85, style: 'outline', start: 0, review: false },
    { id: 91, kind: 'ordered', level: 2, group: 85, style: 'outline', start: 0, review: false },
    { id: 92, kind: 'bullet', level: 3, group: 90, style: 'disc', start: 0, review: false },
    { id: 128, kind: 'ordered', level: 2, group: 85, style: 'outline', start: 0, review: false }
  ];
  const batches = [];
  await page.route('**/api/numbering', async route => {
    const { action, candidates, previous } = route.request().postDataJSON();
    if (action === 'status') {
      await route.fulfill({ json: { provider: 'numbering.test', model: 'fixture-model', batchLimit: 40 } });
      return;
    }
    const ids = candidates.map(item => item.id);
    assert.ok(!ids.includes(90));
    batches.push({ size: ids.length, previous: previous?.map(({ id, group }) => [id, group]) });
    await route.fulfill({ json: { items: decisions.filter(item => ids.includes(item.id)) } });
  });

  await page.locator('#organize-numbering').click();
  await page.locator('#numbering-apply').waitFor();
  assert.deepEqual(batches, [
    { size: 40, previous: undefined }, { size: 40, previous: undefined },
    { size: 40, previous: [[85, 85]] }
  ]);
  assert.match(await page.locator('#numbering-status').textContent(), /5 处调整，1 处待确认/);
  assert.equal(await page.locator('#toast').filter({ hasText: '结构无效' }).count(), 0);
  await page.getByText('第 92 行 · 找不到可用的组首。').waitFor();
  const label = text => page.locator('#preview [data-number-label]').evaluateAll((nodes, text) =>
    nodes.find(node => [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE &&
      child.textContent.trim() === text))?.dataset.numberLabel, text);
  assert.equal(await label('本批后续条目'), '5.4');
  assert.equal(await label('下一批条目'), '5.5');
  assert.equal(await label('投标费用'), undefined);
  await page.locator('#preview p').filter({ hasText: /^投标费用$/ }).waitFor();
  assert.equal(await page.locator('#editor').inputValue(), original);

  await page.locator('#numbering-apply').click();
  const applied = (await page.locator('#editor').inputValue()).split('\n');
  assert.equal(applied[89], original.split('\n')[89]);
  assert.equal(applied[91], original.split('\n')[91]);
  assert.match(applied[127], /md-number:v1/);
});

test('raw multilevel clauses share native Word numbering and preserve plain paragraphs in print', { timeout: 60000 }, async t => {
  const server = await serve();
  t.after(server.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page } = await launchPage(browser, server.url);
  const clauses = [
    ['11.', '第十一章'], ['11.1.', '第一条'], ['11.1.1.', '第一款'], ['11.1.2.', '第二款'],
    ['11.2.', '第二条'], ['11.2.1.', '另起第一款'], ['12.', '第十二章'], ['12.1.', '下章第一条'],
    ['12.1.1.', '下章第一款']
  ];
  const lines = clauses.map(([number, body]) => `${number} ${body}`);
  lines.splice(3, 0, '条款间的纯文字');
  lines.splice(7, 0, '●明确的项目符号');
  await edit(page, ['开头的纯文字', ...lines, '结尾的纯文字'].join('\n'));
  const checkLayout = async root => {
    assert.deepEqual(await root.locator('[data-number-label]').evaluateAll(nodes =>
      nodes.map(node => node.dataset.numberLabel)), clauses.map(([number]) => number));
    await root.locator('ul > li').filter({ hasText: /^明确的项目符号$/ }).waitFor();
    for (const text of ['开头的纯文字', '条款间的纯文字', '结尾的纯文字']) {
      assert.equal(await root.locator('p').filter({ hasText: text }).evaluate(p => p.closest('li')), null);
    }
  };
  const preview = page.locator('#preview .markdown-body');
  await preview.locator('[data-number-label="12.1.1."]').waitFor();
  await checkLayout(preview);

  const word = await download(page, () => page.evaluate(() => { void exportWord(); }));
  const files = require('../vendor/fflate.js').unzipSync(word.bytes);
  const paragraphs = Buffer.from(files['word/document.xml']).toString().match(/<w:p>.*?<\/w:p>/gs);
  const paragraph = body => paragraphs.find(text => text.includes(`>${body}</w:t>`));
  const numId = /<w:numId w:val="(\d+)"/;
  const group = paragraph(clauses[0][1]).match(numId)?.[1];
  assert.ok(group);
  for (const [number, body] of clauses) {
    const xml = paragraph(body);
    assert.equal(xml.match(numId)?.[1], group);
    assert.ok(xml.includes(`<w:ilvl w:val="${number.split('.').length - 2}"/>`));
    assert.ok(!xml.includes(`>${number} `));
    assertWordListIndent(xml);
  }
  assert.doesNotMatch(paragraph('条款间的纯文字'), /w:numPr/);
  assert.ok(paragraph('明确的项目符号').match(numId));
  assertWordListIndent(paragraph('明确的项目符号'));
  const numbering = Buffer.from(files['word/numbering.xml']).toString();
  assert.match(numbering, /<w:start w:val="11"\/>/);
  assert.match(numbering, /<w:lvlText w:val="%1\.%2\.%3\."\/>/);

  await page.evaluate(() => {
    window.print = () => { window.printRequested = true; };
    void exportPDF();
  });
  await page.waitForFunction(() => window.printRequested);
  await page.emulateMedia({ media: 'print' });
  const print = page.locator('#pdf-document .markdown-body');
  await checkLayout(print);
  assert.equal(await print.locator('[data-number-label="11.1.2."]').evaluate(li => getComputedStyle(li).listStylePosition), 'inside');
  assert.equal(await print.locator('[data-source-outline]').evaluateAll(items =>
    new Set(items.map(item => item.getBoundingClientRect().left)).size), 1);
  assert.equal((await page.pdf()).subarray(0, 5).toString(), '%PDF-');
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
  assert.equal(await page.locator('#preview li').first().textContent(), 'Previous');
  const latest = await download(page, () => page.evaluate(() => exportFile()));
  assert.match(latest.bytes.toString(), /^# Latest/);
  await page.locator('#preview-pause').click();
  await page.waitForFunction(() => document.querySelector('#preview li')?.textContent.trim() === 'Latest');

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



test('list alignment, source line numbers and numbering undo in fullscreen', { timeout: 30000 }, async t => {
  const server = await serve();
  t.after(server.close);
  const browser = await chromium.launch({ args: ['--window-size=1280,800'] });
  t.after(() => browser.close());
  const { page } = await launchPage(browser, server.url, true);
  const editor = page.locator('#editor');
  const lines = page.locator('.editor-line-mirror > span');
  const preview = page.locator('#preview');
  const legacy = '# <!-- md-number:v1:h:g1:1:outline:1 --> 上级\n## <!-- md-number:v1:h:g1:2:outline:1 --> 下级';
  await edit(page, legacy);
  assert.deepEqual(await preview.locator('li[data-number-label]').evaluateAll(items =>
    items.map(item => item.dataset.numberLabel)), ['1', '1.1']);
  assert.equal(await editor.inputValue(), legacy);

  const source = '合同条款\n\n9. 第一个条目\n   - 下级项目\n     1. 第三级\n## 旧文档的二级标题';
  await edit(page, source);
  await page.waitForFunction(() => document.querySelectorAll('.editor-line-mirror > span').length === 6);
  assert.equal(await lines.count(), 6);
  assert.deepEqual(await lines.evaluateAll(rows => rows.map(row => row.dataset.line)), ['1', '2', '3', '4', '5', '6']);
  assert.equal(await preview.locator('h1,h2,h3,h4,h5,h6').count(), 0);
  assert.equal(await preview.locator('p').first().textContent(), '合同条款');
  assert.equal(await preview.locator('ol > li > ul > li > ol > li').textContent(), '第三级');
  const leftEdges = await preview.locator('li').evaluateAll(items =>
    items.map(item => item.getBoundingClientRect().left));
  assert.equal(new Set(leftEdges).size, 1);
  assert.ok(await preview.locator('li').evaluateAll(items =>
    items.every(item => getComputedStyle(item).fontSize === '16px')));
  assert.equal(await page.locator('#outline-button, #outline-modal, #template-modal, #font-size-toggle').count(), 0);

  const wrapped = '宽文字带换行'.repeat(100) + '\n\n' + Array.from({ length: 110 }, (_, i) => '第 ' + i + ' 项').join('\n');
  await editor.fill(wrapped);
  await lines.last().waitFor();
  await page.waitForFunction(() => document.querySelector('[data-line="112"]'));
  assert.equal(await lines.first().evaluate(line => line.clientHeight > line.nextElementSibling.clientHeight * 2), true);
  const heights = await editor.evaluate(el => {
    const mirror = document.querySelector('.editor-line-mirror');
    return { editor: el.scrollHeight, mirror: mirror.scrollHeight, widths: [el.clientWidth, mirror.clientWidth] };
  });
  assert.ok(Math.abs(heights.editor - heights.mirror) <= 2,
    'Line mirror must wrap at the same width as the textarea ' + JSON.stringify(heights));
  await editor.evaluate(el => { el.scrollTop = 500; });
  await page.waitForFunction(() => {
    const el = document.getElementById('editor');
    const { top } = document.querySelector('.editor-line-mirror').getBoundingClientRect();
    return Math.abs(top + el.scrollTop - el.getBoundingClientRect().top) < 1;
  });
  await edit(page, source);
  await page.waitForFunction(() => document.querySelectorAll('.editor-line-mirror > span').length === 6);

  await page.locator('#view-dropdown > button').click();
  await page.locator('[data-i18n="systemFullscreen"]').click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  const toolbar = page.locator('.editor-toolbar');
  assert.ok(await toolbar.locator(':scope > div > button, :scope > div > .dropdown > button')
    .evaluateAll(buttons => {
      const centers = buttons.map(button => {
        const { top, height, right } = button.getBoundingClientRect();
        return { y: top + height / 2, right };
      });
      return centers.every(({ y, right }) => Math.abs(y - centers[0].y) < 1 && right <= innerWidth);
    }));
  await page.evaluate(() => document.exitFullscreen());

  await page.locator('#organize-numbering').click();
  await page.locator('[onclick="saveNumberingSettings()"]').click();
  await page.route('**/api/numbering', async route => {
    const { action, candidates } = route.request().postDataJSON();
    if (action !== 'analyze') return route.fulfill({ json: { provider: 'fixture', model: 'test' } });
    assert.deepEqual(candidates.map(row => row.excerpt), ['第一个条目', '下级项目', '第三级']);
    assert.ok(candidates.every(row => ['ordered', 'bullet'].includes(row.kind)));
    const styles = ['upper-alpha', 'circle', 'outline'];
    await route.fulfill({ json: { items: candidates.map((row, index) => ({
      id: row.id, kind: row.kind, level: index + 1,
      group: candidates[0].id,
      style: styles[index], start: 0, review: false
    })) } });
  });
  await page.locator('#organize-numbering').click();
  const apply = page.locator('#numbering-apply');
  const revert = page.locator('#numbering-undo');
  await apply.waitFor();
  assert.ok(await revert.isDisabled());
  assert.equal(await revert.evaluate(el => el.nextElementSibling.id), 'numbering-collapse');
  assert.deepEqual(await page.locator('[data-numbering-group]').evaluateAll(groups =>
    groups.map(group => group.dataset.numberingGroup)), ['ordered:1', 'bullet:2', 'ordered:3']);
  const labels = () => preview.locator('[data-number-label]').evaluateAll(nodes =>
    nodes.map(node => node.dataset.numberLabel));
  assert.deepEqual(await labels(), ['A.', '○', '1.1.1']);
  assert.equal(await editor.inputValue(), source);
  await apply.click();
  assert.ok(await revert.isEnabled());
  assert.notEqual(await editor.inputValue(), source);
  await revert.click();
  assert.equal(await editor.inputValue(), source);
  assert.deepEqual(await labels(), []);
  assert.ok(await revert.isDisabled());
  assert.ok(await apply.isVisible());
  await apply.click();
  await editor.press('End');
  await page.keyboard.insertText(' 附注');
  assert.ok(await revert.isDisabled());
  assert.match(await editor.inputValue(), /附注/);
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


