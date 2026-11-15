/* One record per workspace. The revision check and write share an IndexedDB transaction. */
const draftStorage = (() => {
  const key = 'md_editor_draft';
  const databaseName = 'markdown-editor';
  const defaultId = 'default';
  let database;
  let storage;

  function readLegacy() {
    const text = storage.getItem('md_editor_content');
    if (text === null) return null;
    return { text, filename: storage.getItem('md_editor_filename') || '', revision: 1 };
  }

  function withDatabase(update, recordKey = key) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('drafts', 'readwrite');
      const store = transaction.objectStore('drafts');
      let result;
      const request = store.get(recordKey);
      request.onsuccess = () => {
        try {
          result = update(request.result || null, record => store.put(record, recordKey));
        } catch (error) {
          result = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(result instanceof Error ? result : transaction.error);
    });
  }

  function withLocalStorage(update, recordKey = key) {
    const run = () => update(
      JSON.parse(storage.getItem(recordKey) || 'null'),
      record => storage.setItem(recordKey, JSON.stringify(record))
    );
    return navigator.locks ? navigator.locks.request(recordKey, run) : Promise.resolve().then(run);
  }

  async function open() {
    try { storage = window.localStorage; } catch (_) {}
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      try {
        database = await new Promise((resolve, reject) => {
          const request = indexedDB.open(databaseName, 1);
          request.onupgradeneeded = () => request.result.createObjectStore('drafts');
          request.onsuccess = () => resolve(request.result);
          request.onerror = request.onblocked = () => reject(request.error);
        });
        database.onversionchange = () => database.close();
      } catch (_) {}
    }
    const access = database ? withDatabase : withLocalStorage;
    if (!storage && !database) throw new Error('Storage is unavailable');
    return access((record, put) => {
      if (record) {
        if (record.id) return record;
        const upgraded = { ...record, id: defaultId, savedAt: null };
        put(upgraded);
        return upgraded;
      }
      if (!storage) return null;
      let legacy;
      try {
        legacy = JSON.parse(storage.getItem(key) || 'null') || readLegacy();
      } catch (_) {
        return null;
      }
      if (legacy) {
        legacy = { ...legacy, id: defaultId, savedAt: null };
        put(legacy);
      }
      return legacy;
    });
  }

  async function save(draft, expectedRevision) {
    if (!database && !storage) throw new Error('Storage is unavailable');
    const access = database ? withDatabase : withLocalStorage;
    if (!database && draft.id && draft.id !== defaultId) throw new Error('Workspace storage unavailable');
    return access((current, put) => {
      const revision = current?.revision || 0;
      if (revision !== expectedRevision) return null;
      const record = { ...draft, id: draft.id || defaultId, revision: revision + 1, savedAt: Date.now() };
      put(record);
      return record;
    }, recordKey(draft.id || defaultId));
  }

  function read(id = defaultId) {
    return (database ? withDatabase : withLocalStorage)(record => record, recordKey(id));
  }

  function recordKey(id) {
    return id === defaultId ? key : 'document:' + id;
  }

  function canRecover() { return Boolean(database); }

  async function checkpoint(draft, reason = 'save') {
    if (!database) return false;
    const version = {
      text: draft.text, filename: draft.filename, revision: draft.revision,
      savedAt: Date.now(), reason
    };
    return withDatabase((history, put) => {
      const versions = history || [];
      const latest = versions[0];
      if (latest?.text === version.text && latest.filename === version.filename) return true;
      const byteLimit = 16 * 1024 * 1024;
      let bytes = 0;
      const recent = [version, ...versions].slice(0, 10).filter(entry => {
        bytes += 2 * (entry.text.length + entry.filename.length) + 128;
        return bytes <= byteLimit;
      });
      if (!recent.length) return false;
      put(recent);
      return true;
    }, 'history:' + (draft.id || defaultId));
  }

  function revisions(id = defaultId) {
    return database ? withDatabase(history => history || [], 'history:' + id) : Promise.resolve([]);
  }

  async function putAttachment(record) {
    if (!database) throw new Error('Attachment storage unavailable');
    return withDatabase((existing, put) => {
      if (!existing) put(record);
    }, 'attachment:' + record.id);
  }

  function getAttachment(id) {
    return database ? withDatabase(record => record, 'attachment:' + id) : Promise.resolve(null);
  }

  function workspaceTransaction(mode, start) {
    if (!database) return Promise.reject(new Error('Workspace storage unavailable'));
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('drafts', mode);
      let value;
      function finish(result) { value = result; }
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(transaction.error || new Error('Workspace transaction aborted'));
      start(transaction.objectStore('drafts'), finish);
    });
  }

  function documents() {
    return workspaceTransaction('readonly', (store, finish) => {
      const records = [];
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { finish(records); return; }
        if (cursor.key === key || String(cursor.key).startsWith('document:')) records.push(cursor.value);
        cursor.continue();
      };
    });
  }

  function workspaceSnapshot() {
    return workspaceTransaction('readonly', (store, finish) => {
      const docs = [];
      const histories = Object.create(null);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          finish(docs.map(entry => ({ ...entry, history: histories[entry.id] || [] })));
          return;
        }
        if (cursor.key === key || String(cursor.key).startsWith('document:')) docs.push(cursor.value);
        if (String(cursor.key).startsWith('history:')) histories[String(cursor.key).slice(8)] = cursor.value;
        cursor.continue();
      };
    });
  }

  function importWorkspace(entries, attachments) {
    return workspaceTransaction('readwrite', (store, finish) => {
      const restored = [];
      const request = store.getAllKeys();
      request.onsuccess = () => {
        const used = new Set(request.result);
        for (const entry of entries) {
          const { history, ...document } = entry;
          let id = document.id;
          while (used.has(recordKey(id))) id = crypto.randomUUID();
          used.add(recordKey(id));
          store.add({ ...document, id }, recordKey(id));
          if (history.length) store.put(history, 'history:' + id);
          restored.push(id);
        }
        for (const record of attachments) store.put(record, 'attachment:' + record.id);
        finish(restored);
      };
    });
  }

  return { putAttachment, getAttachment, open, save, read, checkpoint, revisions, canRecover, defaultId,
    documents, workspaceSnapshot, importWorkspace };
})();
