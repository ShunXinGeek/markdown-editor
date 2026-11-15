const editorAttachments = (() => {
  const types = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml' };
  const limit = 64 * 1024 * 1024;
  const ref = /(?<![\w/])attachments\/([a-f0-9]{64}\.(?:png|jpeg|gif|webp|bmp|avif|svg))(?=[)\s"'<>]|$)/g;

  function ids(text) { return [...new Set(Array.from(text.matchAll(ref), match => match[1]))]; }

  function asDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function identify(bytes, suffix) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('') + '.' + suffix;
  }

  async function put(blob) {
    const suffix = Object.keys(types).find(ext => types[ext] === blob.type);
    if (!suffix || blob.size === 0 || blob.size > limit) throw new Error('Unsupported image');
    const id = await identify(await blob.arrayBuffer(), suffix);
    await draftStorage.putAttachment({ id, blob });
    return 'attachments/' + id;
  }

  async function resolve(text) {
    if (!text.includes('attachments/')) return { text, missing: [] };
    const values = new Map();
    const missing = [];
    await Promise.all(ids(text).map(async id => {
      const record = await draftStorage.getAttachment(id);
      if (record) values.set(id, await asDataUrl(record.blob));
      else missing.push(id);
    }));
    return { text: text.replace(ref, (path, id) => values.get(id) || path), missing };
  }

  function download(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function unpack(bytes) {
    if (bytes.length > limit) throw new Error('Archive is too large');
    let total = 0;
    return fflate.unzipSync(bytes, { filter: info => {
      total += info.originalSize;
      if (total > limit) throw new Error('Archive expands beyond the limit');
      return true;
    } });
  }

  async function getFiles(texts) {
    const files = {};
    let total = 0;
    for (const id of new Set(texts.flatMap(ids))) {
      const record = await draftStorage.getAttachment(id);
      if (!record) throw new Error('Missing attachment: ' + id);
      total += record.blob.size;
      if (total > limit) throw new Error('Attachments exceed the size limit');
      files['attachments/' + id] = new Uint8Array(await record.blob.arrayBuffer());
    }
    return files;
  }

  async function readFiles(files, texts) {
    const records = [];
    for (const id of new Set(texts.flatMap(ids))) {
      const bytes = files['attachments/' + id];
      const suffix = id.split('.').at(-1);
      if (!bytes || await identify(bytes, suffix) !== id) throw new Error('Invalid attachment: ' + id);
      records.push({ id, blob: new Blob([bytes], { type: types[suffix] }) });
    }
    return records;
  }

  async function downloadBundle(text, name) {
    const files = await getFiles([text]);
    const title = name.replace(/[\\/:*?"<>|]/g, '_');
    files[title + '.md'] = fflate.strToU8(text);
    download(fflate.zipSync(files, { level: 0 }), title + '.zip', 'application/zip');
  }

  async function readBundle(file) {
    if (file.size > limit) throw new Error('Archive is too large');
    const files = unpack(new Uint8Array(await file.arrayBuffer()));
    const docs = Object.keys(files).filter(name => /^[^\\/]+\.md$/i.test(name));
    if (docs.length !== 1) throw new Error('Expected one Markdown file');
    const filename = docs[0];
    const text = new TextDecoder('utf-8', { fatal: true }).decode(files[filename]);
    const records = await readFiles(files, [text]);
    for (const record of records) await draftStorage.putAttachment(record);
    return { filename, text };
  }

  return { ids, asDataUrl, put, resolve, download, unpack, getFiles, readFiles, downloadBundle, readBundle };
})();
