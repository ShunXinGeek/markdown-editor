const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium, firefox } = require('playwright');
const { spawnSync } = require('node:child_process');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
      await page.locator('[onclick="openOutline()"]').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#outline-list option').count(), 4);
      await page.locator('#outline-list').selectOption('2');
      await page.locator('#outline-list').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#editor').evaluate(el => el.selectionStart), text.lastIndexOf('## Repeat'));
      await page.locator('[onclick="openTemplates()"]').click();
      await page.locator('#template-list').selectOption('meeting');
      const preview = await page.locator('#template-content').inputValue();
      assert.match(preview, /会议纪要/);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => draft.text), text);
      await page.locator('[onclick="openTemplates()"]').click();
      await page.locator('#template-modal [data-i18n="insert"]').click();
      assert.ok((await page.evaluate(() => draft.text)).includes(preview));
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


