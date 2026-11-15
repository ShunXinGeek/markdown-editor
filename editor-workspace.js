const editorWorkspace = (() => {
  const limit = 64 * 1024 * 1024;

  async function checksum(bytes) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function download() {
    const documents = await draftStorage.workspaceSnapshot();
    const manifest = fflate.strToU8(JSON.stringify({ format: 'markdown-editor-workspace', version: 1, documents }));
    const files = await editorAttachments.getFiles(documents.flatMap(entry =>
      [entry.text, ...entry.history.map(snapshot => snapshot.text)]));
    const length = Object.values(files).reduce((sum, bytes) => sum + bytes.length, manifest.length);
    if (length > limit) throw new Error('Backup exceeds the size limit');
    files['workspace.json'] = manifest;
    files['workspace.sha256'] = fflate.strToU8(await checksum(manifest));
    editorAttachments.download(fflate.zipSync(files, { level: 0 }), 'markdown-workspace.zip', 'application/zip');
  }

  function safeFields(entry) {
    if (!entry || typeof entry.text !== 'string' || typeof entry.filename !== 'string' ||
      !Number.isSafeInteger(entry.revision) || entry.revision < 0 ||
      (entry.savedAt !== null && !Number.isFinite(entry.savedAt))) throw new Error('Invalid document');
    return { text: entry.text, filename: entry.filename, revision: entry.revision, savedAt: entry.savedAt };
  }

  async function restore(file) {
    if (file.size > limit) throw new Error('Backup exceeds the size limit');
    const files = editorAttachments.unpack(new Uint8Array(await file.arrayBuffer()));
    const decode = new TextDecoder('utf-8', { fatal: true });
    if (!files['workspace.json'] || decode.decode(files['workspace.sha256']) !== await checksum(files['workspace.json'])) {
      throw new Error('Backup checksum mismatch');
    }
    const manifest = JSON.parse(decode.decode(files['workspace.json']));
    if (manifest.format !== 'markdown-editor-workspace' || manifest.version !== 1 ||
      !Array.isArray(manifest.documents) || manifest.documents.length > 1000) throw new Error('Unsupported backup');
    const used = new Set();
    const documents = manifest.documents.map(entry => {
      if (typeof entry.id !== 'string' || !/^[a-z0-9-]{1,50}$/i.test(entry.id) || used.has(entry.id) ||
        !Array.isArray(entry.history) || entry.history.length > 10) throw new Error('Invalid document history');
      used.add(entry.id);
      const tags = entry.tags || [];
      if (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== 'string' || tag.length > 80)) {
        throw new Error('Invalid document tags');
      }
      return { ...safeFields(entry), id: entry.id, tags, history: entry.history.map(safeFields) };
    });
    const attachments = await editorAttachments.readFiles(files, documents.flatMap(entry =>
      [entry.text, ...entry.history.map(snapshot => snapshot.text)]));
    return draftStorage.importWorkspace(documents, attachments);
  }

  return { download, restore };
})();
