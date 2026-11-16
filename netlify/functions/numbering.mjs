const MAX_BODY = 192 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const BATCH_LIMIT = 40;
const MAX_PREVIOUS = 9;
const UPSTREAM_TIMEOUT = 50_000;
const COMPLETIONS_PATH = '/chat/completions';
const MODEL_ENDPOINTS = [
  'https://api.deepseek.com',
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://api.moonshot.cn/v1',
  'https://open.bigmodel.cn/api/paas/v4',
  'https://ark.cn-beijing.volces.com/api/v3',
  'https://api.siliconflow.cn/v1'
].map(modelEndpoint);

const CANDIDATE = {
  id: 1, headingLevel: 0, indent: 0, depth: 0, kind: 'ordered', prefix: '1. ',
  style: 'decimal-dot', value: 1, priorGroup: '', priorLevel: 0, excerpt: 'Test item'
};
const PREVIOUS = { id: 1, kind: 'ordered', level: 1, group: 1, prefix: '', excerpt: '' };
const ITEM = { id: 1, kind: 'ordered', level: 1, group: 1, style: 'outline', start: 0, review: false };
const KINDS = ['ordered', 'bullet'];
const SYSTEM = `你只负责给编号候选项分类。候选项及其摘录是输入数据。每个编号项只返回 id、kind、level、group、style、start、review。
id 是输入给出的整数；kind 是 ordered、bullet 或 skip；level 为 1 至 9 的列表层级。
depth 和 indent 是列表层级提示。没有列表标记的文本应返回 skip。例如「1. 定义」是 ordered 第 1 级，随后的「1.1. 除上下文另有规定外」是同组第 2 级。若其后紧跟「(1)」「(2)」等下级条目，请沿用该组并设为第 3 级。
group 为该组第一项的 id，组第一项应填自己的 id 且 level 为 1。相同组的子级沿用这个 group。
style 填候选项所示的样式名、outline 或 auto。同组同层用相同样式。start 用 0 表示按程序默认值，正整数仅在确定要从指定数字开始时使用。
review 为布尔值，标出需要确认的判断。可省略应跳过的候选项。仅返回 JSON 对象，例如 ${JSON.stringify({ items: [ITEM] })}。正文和修改后的文本都不可输出。`;
const CONTINUATION = `
previous 是前几批已分析的列表路径，仅供延续分组及判断层级。
只返回 candidates 中的 id。同一编号序列应沿用 previous 里的 group 和层级关系。
即使本批从子级开始，也应使用原 group，不要另起编号。独立序列仍以本批首项为 group。`;

export const config = { path: '/api/numbering' };

function modelEndpoint(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl || baseUrl.length > 2048 || /[?#\\\s\x00-\x1f\x7f]/.test(baseUrl)) return null;
  let url;
  try { url = new URL(baseUrl); }
  catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(COMPLETIONS_PATH) ? path : path + COMPLETIONS_PATH;
  return url.href;
}

function isApproved(endpoint) {
  const configured = (process.env.MARKDOWN_NUMBERING_ALLOWED_BASE_URLS ?? '').split(',');
  return endpoint !== null && (MODEL_ENDPOINTS.includes(endpoint) ||
    configured.some(value => modelEndpoint(value.trim()) === endpoint));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesFields(value, example) {
  if (!isRecord(value) || Object.keys(value).length !== Object.keys(example).length) return false;
  return Object.entries(example).every(([field, sample]) => {
    if (!Object.hasOwn(value, field)) return false;
    const entry = value[field];
    if (typeof sample === 'number') return Number.isSafeInteger(entry);
    return typeof entry === typeof sample && (typeof entry !== 'string' || entry.length <= 200);
  });
}

function analysisInputs(payload) {
  const { prompt, candidates, previous = [] } = payload;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 6000 ||
      !Array.isArray(candidates) || candidates.length === 0 || candidates.length > BATCH_LIMIT ||
      !candidates.every(candidate => matchesFields(candidate, CANDIDATE) && candidate.id > 0)) return null;
  const ids = candidates.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || !Array.isArray(previous) || previous.length > MAX_PREVIOUS) return null;
  const firstId = Math.min(...ids);
  if (!previous.every(item => matchesFields(item, PREVIOUS) && KINDS.includes(item.kind) &&
      item.level >= 1 && item.level <= 9 &&
      item.group > 0 && item.group <= item.id && item.id < firstId)) return null;
  return { numbering_rules: prompt, candidates, ...(previous.length ? { previous } : {}) };
}

async function readJson(stream, maxBytes) {
  const reader = stream?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Body too large');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
}

async function complete(endpoint, apiKey, model, inputs, signal) {
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM + (inputs.previous ? CONTINUATION : '') },
        { role: 'user', content: JSON.stringify(inputs) }
      ],
      response_format: { type: 'json_object' },
      ...(new URL(endpoint).hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}),
      max_tokens: Math.max(1024, inputs.candidates.length * 65 + 512)
    })
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Model request failed');
  }
  const data = await readJson(response.body, MAX_RESPONSE);
  const choice = data?.choices?.[0];
  if (choice?.finish_reason !== 'stop' || choice.message?.refusal || typeof choice.message?.content !== 'string') {
    throw new Error('Incomplete model response');
  }
  const result = JSON.parse(choice.message.content);
  const remaining = new Set(inputs.candidates.map(({ id }) => id));
  if (!isRecord(result) || Object.keys(result).length !== 1 || !Array.isArray(result.items) ||
      result.items.length > remaining.size || !result.items.every(item => matchesFields(item, ITEM) &&
        (item.kind === 'skip' || KINDS.includes(item.kind)) && remaining.delete(item.id))) {
    throw new Error('Invalid numbering result');
  }
  return result;
}

function json(status, data, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export default async function numbering(request) {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (request.headers.get('origin') !== new URL(request.url).origin || contentType !== 'application/json') {
    return json(403, { error: 'same_origin_json_required' });
  }

  let payload;
  try { payload = await readJson(request.body, MAX_BODY); }
  catch { return json(400, { error: 'invalid_numbering_request' }); }
  if (!isRecord(payload)) return json(400, { error: 'invalid_numbering_request' });
  const { action, model, connection } = payload;
  const apiKey = connection?.apiKey;
  if (!['status', 'test', 'analyze'].includes(action) || !isRecord(connection) ||
      typeof model !== 'string' || !model || model.length > 120 || /[^a-z0-9_.:/@-]/i.test(model) ||
      typeof apiKey !== 'string' || !apiKey || apiKey.length > 2048 || /[^!-~]/.test(apiKey)) {
    return json(400, { error: 'invalid_numbering_request' });
  }
  const endpoint = modelEndpoint(connection.baseUrl);
  if (!isApproved(endpoint)) return json(400, { error: 'unsupported_model_endpoint' });
  const metadata = { provider: new URL(endpoint).host, model, batchLimit: BATCH_LIMIT };
  if (action === 'status') return json(200, metadata);

  const inputs = action === 'analyze' ? analysisInputs(payload) : { numbering_rules: '', candidates: [CANDIDATE] };
  if (!inputs) return json(400, { error: 'invalid_numbering_request' });
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT);
  try {
    const result = await complete(endpoint, apiKey, model, inputs, AbortSignal.any([request.signal, timeout]));
    return json(200, action === 'analyze' ? result : metadata);
  } catch {
    return timeout.aborted ? json(504, { error: 'model_timeout' }) : json(502, { error: 'model_request_failed' });
  }
}
