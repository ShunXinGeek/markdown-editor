const test = require('node:test');
const assert = require('node:assert/strict');

const origin = 'https://deploy-preview-1--editor.netlify.app';
const connection = { baseUrl: 'https://api.deepseek.com/', apiKey: 'fixture-key' };
const settings = { model: 'fixture-model', connection };
const candidate = {
  id: 12, headingLevel: 2, indent: 0, depth: 0, kind: 'heading', prefix: '9.9',
  style: 'outline', value: 9, priorGroup: '', priorLevel: 0, excerpt: 'Next section'
};
const previous = [{ id: 6, kind: 'heading', level: 1, group: 6, prefix: '9.', excerpt: 'Chapter' }];
const plan = { items: [{ id: 12, kind: 'heading', level: 2, group: 6, style: 'outline', start: 0, review: false }] };

function post(payload, requestOrigin = origin) {
  return new Request(`${origin}/api/numbering`, {
    method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
}

function upstream(plan) {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }] });
}

test('Netlify numbering validates origin, payload and the configured model endpoint', async t => {
  const { default: numbering, config } = await import('../netlify/functions/numbering.mjs');
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected upstream request'); });
  assert.equal(config.path, '/api/numbering');
  assert.equal((await numbering(new Request(`${origin}/api/numbering`))).status, 405);
  assert.equal((await numbering(post({ ...settings, action: 'test' }, 'https://other.example'))).status, 403);
  const status = await numbering(post({ ...settings, action: 'status' }));
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  const metadata = await status.json();
  assert.equal(metadata.provider, 'api.deepseek.com');
  assert.equal(metadata.model, settings.model);
  assert.equal(metadata.batchLimit, 40);

  for (const baseUrl of ['https://other.example/v1', 'https://api.deepseek.com/unapproved', 'http://127.0.0.1']) {
    const response = await numbering(post({ ...settings, action: 'test', connection: { ...connection, baseUrl } }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'unsupported_model_endpoint' });
  }
  assert.equal((await numbering(post({ ...settings, action: 'test', padding: 'a'.repeat(192 * 1024) }))).status, 400);
  assert.equal((await numbering(post({ ...settings, action: 'test', connection: undefined }))).status, 400);
  assert.equal((await numbering(post({ ...settings, action: 'analyze', prompt: 'rules', candidates: [candidate, candidate] }))).status, 400);
  assert.equal((await numbering(post({ ...settings, action: 'analyze', prompt: 'rules', candidates: [candidate],
    previous: [{ ...previous[0], id: candidate.id }] }))).status, 400);
  const oversizeBatch = Array.from({ length: metadata.batchLimit + 1 }, (_, id) => ({ ...candidate, id: id + 1 }));
  assert.equal((await numbering(post({ ...settings, action: 'analyze', prompt: 'rules', candidates: oversizeBatch }))).status, 400);
  assert.equal(fetch.mock.callCount(), 0);
});

test('Netlify numbering calls the model and preserves cross-batch context', async t => {
  const { default: numbering } = await import('../netlify/functions/numbering.mjs');
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const payload = JSON.parse(options.body);
    const inputs = JSON.parse(payload.messages[1].content);
    fetched.push(inputs);
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    assert.equal(payload.model, settings.model);
    assert.deepEqual(payload.response_format, { type: 'json_object' });
    assert.deepEqual(payload.thinking, { type: 'disabled' });
    return upstream(inputs.previous ? plan : { items: [] });
  });
  const connected = await numbering(post({ ...settings, action: 'test' }));
  assert.equal(connected.status, 200);
  assert.equal((await connected.json()).model, settings.model);
  assert.equal(fetched[0].candidates[0].excerpt, 'Test heading');
  const response = await numbering(post({ ...settings, action: 'analyze', prompt: 'rules', candidates: [candidate], previous }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), plan);
  assert.deepEqual(fetched[1], { numbering_rules: 'rules', candidates: [candidate], previous });
});

test('Netlify numbering allows only the configured paths for custom model endpoints', async t => {
  const { default: numbering } = await import('../netlify/functions/numbering.mjs');
  const name = 'MARKDOWN_NUMBERING_ALLOWED_BASE_URLS';
  const saved = process.env[name];
  process.env[name] = 'https://models.example/v1, https://text.example/openai';
  t.after(() => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });
  const status = baseUrl => numbering(post({ ...settings, action: 'status', connection: { ...connection, baseUrl } }));
  assert.equal((await status('https://models.example/v1/chat/completions')).status, 200);
  assert.equal((await status('https://text.example/openai/')).status, 200);
  assert.equal((await status('https://models.example/other')).status, 400);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(Object.hasOwn(JSON.parse(options.body), 'thinking'), false);
    return upstream({ items: [] });
  });
  const connected = await numbering(post({ ...settings, action: 'test',
    connection: { ...connection, baseUrl: 'https://models.example/v1' } }));
  assert.equal(connected.status, 200);
});

test('Netlify numbering reports rejected keys, malformed model results and timeouts', async t => {
  const { default: numbering } = await import('../netlify/functions/numbering.mjs');
  const fetch = t.mock.method(globalThis, 'fetch', () => new Response('invalid model key', { status: 401 }));
  const request = { ...settings, action: 'analyze', prompt: 'rules', candidates: [candidate], previous };
  const rejected = await numbering(post(request));
  assert.equal(rejected.status, 502);
  assert.deepEqual(await rejected.json(), { error: 'model_request_failed' });
  fetch.mock.mockImplementation(() => upstream({ items: [{ ...plan.items[0], id: 999 }] }));
  assert.equal((await numbering(post(request))).status, 502);
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort());
  fetch.mock.mockImplementation((_url, { signal }) => signal.throwIfAborted());
  assert.equal((await numbering(post(request))).status, 504);
});
