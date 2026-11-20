const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_CLOUDFLARE_OCR_MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const DEFAULT_CLOUDFLARE_ASSESS_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const CLOUDFLARE_LLAMA32_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

const TOTAL_BUDGET_MS = Number(process.env.AI_TOTAL_BUDGET_MS) || 28500; // Netlify synchronous functions stop at ~30 s

const recognitionPrompt = `Transcribe the student's handwritten or printed work exactly as it appears.
Preserve paragraphs, spelling, grammar, punctuation and mistakes. Do not correct, complete or rewrite the text.
Respect the natural reading order. If a word cannot be read, write [неразборчиво].
Return JSON only: {"text":"...","warnings":["..."]}.`;

const recognitionSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } }
  },
  required: ['text', 'warnings'],
  additionalProperties: false
};

const assessmentSchema = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, score: { type: 'integer' }, comment: { type: 'string' } },
        required: ['index', 'score', 'comment'],
        additionalProperties: false
      }
    },
    remarks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string' }, correction: { type: 'string' }, explanation: { type: 'string' },
          type: { type: 'string', enum: ['error', 'style', 'uncertain'] }, include: { type: 'boolean' }
        },
        required: ['quote', 'correction', 'explanation', 'type', 'include'],
        additionalProperties: false
      }
    },
    strengths: { type: 'string' }, priorities: { type: 'string' }, next: { type: 'string' }
  },
  required: ['criteria', 'remarks', 'strengths', 'priorities', 'next'],
  additionalProperties: false
};

// PDF/DOCX import repeats one long band description for every score in the band.
// Merge identical neighbours into "lo-hi: text" and cap the length so the request stays small and fast.
export function compactDescriptors(descriptors) {
  const out = [];
  for (let i = 0; i < descriptors.length;) {
    const text = String(descriptors[i] ?? '').replace(/\s+/g, ' ').trim();
    let j = i;
    while (j + 1 < descriptors.length && String(descriptors[j + 1] ?? '').replace(/\s+/g, ' ').trim() === text) j++;
    if (text) out.push(`${i === j ? i : i + '-' + j}: ${text.length > 300 ? text.slice(0, 300) + '…' : text}`);
    i = j + 1;
  }
  return out;
}

function assessmentPrompt(input) {
  return `You are assisting a teacher, not replacing their judgement. Assess only against the supplied task and rubric.
Write learner-facing comments in English. Do not invent requirements that are missing from the task.
Every quoted fragment must be copied character-for-character from STUDENT_TEXT. Use integer scores within each criterion maximum.
Be concise: use one short sentence of at most 18 words per criterion, return no more than 3 remarks, and keep strengths, priorities and next to at most 20 words each.
Return JSON only, with this shape:
{"criteria":[{"index":0,"score":0,"comment":"..."}],"remarks":[{"quote":"exact source quote","correction":"...","explanation":"...","type":"error|style|uncertain","include":true}],"strengths":"...","priorities":"...","next":"..."}

TASK_CONTEXT:
${JSON.stringify({ topic: input.topic || '', genre: input.genre || '', level: input.level || '', task: input.task || '', expectedLength: input.expectedLength || '' })}

RUBRIC:
${JSON.stringify(input.criteria.map((criterion, index) => ({ index, name: criterion.name, max: criterion.max, descriptors: compactDescriptors(criterion.descriptors) })))}

STUDENT_TEXT:
${input.text}`;
}

function stripJsonFence(value) {
  const text = String(value || '').trim();
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function cleanPlainTranscription(value) {
  let text = stripJsonFence(value).trim();
  const marked = text.match(/<TRANSCRIPTION>\s*([\s\S]*?)\s*<\/TRANSCRIPTION>/i);
  if (marked) return marked[1].trim();
  const introduction = /(?:Here is (?:the )?transcribed text|Transcription)\s*:\s*/i.exec(text);
  if (introduction) text = text.slice(introduction.index + introduction[0].length).trim();
  text = text.replace(/\n\s*\n(?:The text is written|The handwriting|The author(?:'s)? opinion|Overall,? the text|In summary,?)[\s\S]*$/i, '').trim();
  return text;
}

function parseJson(value, provider) {
  const text = stripJsonFence(value);
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  throw new Error(`${provider} вернул ответ, который не удалось разобрать как JSON.`);
}

function textFromCloudflareResult(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  for (const key of ['answer', 'response', 'text', 'output_text', 'generated_text', 'result']) {
    const value = result[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value)) {
      const joined = value.map(item => typeof item === 'string' ? item : item?.text || '').filter(Boolean).join('');
      if (joined.trim()) return joined;
    }
    if (value && typeof value === 'object') {
      const nested = textFromCloudflareResult(value);
      if (nested) return nested;
    }
  }
  return '';
}

async function responseJson(response, provider) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message || body?.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`${provider}: ${message}`);
  }
  return body;
}

function geminiText(body) {
  const text = body?.steps?.filter(step => step.type === 'model_output')
    .flatMap(step => Array.isArray(step.content) ? step.content : [])
    .filter(content => content.type === 'text')
    .map(content => content.text || '').join('').trim();
  if (!text) throw new Error('Gemini не вернул текстовый результат.');
  return text;
}

async function geminiGenerate({ prompt, image, schema, env, fetchImpl }) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('На сервере не задан GEMINI_API_KEY.');
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const input = [{ type: 'text', text: prompt }];
  if (image) input.push({ type: 'image', mime_type: image.mimeType, data: image.base64 });
  const send = generationConfig => fetchImpl('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey, 'api-revision': '2026-05-20' },
    body: JSON.stringify({
      model,
      input,
      response_format: { type: 'text', mime_type: 'application/json', schema },
      generation_config: generationConfig,
      store: false
    })
  });
  // Low thinking effort makes Gemini much faster; fall back to the plain request if the API rejects the field.
  let response = await send({ temperature: 0, thinking_level: 'low' });
  if (response.status === 400) response = await send({ temperature: 0 });
  const body = await responseJson(response, 'Gemini');
  if (body?.status && body.status !== 'completed') throw new Error(`Gemini не завершил запрос: ${body.status}.`);
  return parseJson(geminiText(body), 'Gemini');
}

// Google Cloud Vision: dedicated handwriting/document OCR. Fast and does not use the Gemini free quota.
async function visionRecognize({ image, env, fetchImpl }) {
  const apiKey = env.GOOGLE_CLOUD_VISION_API_KEY;
  if (!apiKey) throw new Error('На сервере не задан GOOGLE_CLOUD_VISION_API_KEY.');
  const response = await fetchImpl('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      requests: [{
        image: { content: image.base64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['en'] }
      }]
    })
  });
  const body = await responseJson(response, 'Google Vision');
  const item = body?.responses?.[0];
  if (item?.error) throw new Error(`Google Vision: ${item.error.message || 'ошибка распознавания'}`);
  const text = (item?.fullTextAnnotation?.text || '').trim();
  if (!text) throw new Error('Google Vision не нашёл текст на изображении.');
  return { text, warnings: ['Сверьте распознанный текст с оригиналом перед оцениванием.'] };
}

function cloudflareCredentials(env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error('На сервере не заданы CLOUDFLARE_ACCOUNT_ID и CLOUDFLARE_API_TOKEN.');
  return { accountId, token };
}

async function cloudflareRecognize({ prompt, image, env, fetchImpl }) {
  const { accountId, token } = cloudflareCredentials(env);
  const model = env.CLOUDFLARE_OCR_MODEL || DEFAULT_CLOUDFLARE_OCR_MODEL;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      task: 'query',
      image: `data:${image.mimeType};base64,${image.base64}`,
      question: `${prompt}\nReturn only the transcription itself. Do not describe or summarize the image.`,
      reasoning: false,
      temperature: 0,
      max_tokens: 8192,
      stream: false
    })
  });
  const body = await responseJson(response, 'Cloudflare OCR');
  const text = textFromCloudflareResult(body?.result);
  if (!text) {
    const fields = body?.result && typeof body.result === 'object' ? Object.keys(body.result).join(', ') : typeof body?.result;
    throw new Error(`Cloudflare OCR не вернул распознанный текст (поля ответа: ${fields || 'нет'}).`);
  }
  try {
    const parsed = parseJson(text, 'Cloudflare OCR');
    if (typeof parsed?.text === 'string' && parsed.text.trim()) {
      return {
        text: parsed.text.trim(),
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : ['Сверьте распознанный текст с оригиналом перед оцениванием.']
      };
    }
  } catch {}
  return { text: cleanPlainTranscription(text), warnings: ['Сверьте распознанный текст с оригиналом перед оцениванием.'] };
}

// Models that answer in JSON mode, best first; the first one the key can use is chosen.
const GROQ_PREFERENCE = [/llama-3.3-70b/, /llama-3.1-70b/, /gpt-oss-120b/, /llama-4/, /qwen/, /gpt-oss-20b/, /llama-3.1-8b/];
const GROQ_EXCLUDED = /whisper|guard|tts|orpheus|playai|compound|embed|safeguard/;
let groqWorkingModel = '';

async function groqModelCandidates(apiKey, fetchImpl, skip) {
  const response = await fetchImpl('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${apiKey}` } });
  const body = await responseJson(response, 'Groq');
  const ids = (body?.data || []).map(item => item?.id).filter(id => typeof id === 'string' && !GROQ_EXCLUDED.test(id) && !skip.includes(id));
  const ranked = [];
  for (const pattern of GROQ_PREFERENCE) for (const id of ids) if (pattern.test(id) && !ranked.includes(id)) ranked.push(id);
  return ranked.slice(0, 3);
}

// Groq (OpenAI-compatible chat API): fast Llama 70B, used first for comments and feedback.
async function groqAssess({ prompt, env, fetchImpl }) {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) throw new Error('На сервере не задан GROQ_API_KEY.');
  const send = model => fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 2500,
      response_format: { type: 'json_object' }
    })
  });
  const tried = [];
  let model = env.GROQ_MODEL || groqWorkingModel || DEFAULT_GROQ_MODEL;
  let queue = null, response;
  for (;;) {
    tried.push(model);
    response = await send(model);
    if (response.ok) break;
    const errorBody = await response.clone().json().catch(() => null);
    const message = errorBody?.error?.message || '';
    // Only a missing or forbidden model is worth retrying with another model.
    if (!(response.status === 404 || /model/i.test(message) && /not exist|no access|decommission|not found|not supported/i.test(message))) break;
    queue ??= await groqModelCandidates(apiKey, fetchImpl, tried);
    model = queue.shift();
    if (!model) break;
  }
  const body = await responseJson(response, 'Groq');
  groqWorkingModel = tried[tried.length - 1];
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Groq не вернул текстовый результат.');
  return parseJson(text, 'Groq');
}

// Translation of the teacher-approved feedback texts into Russian or Kazakh (Groq first, Gemini as backup).
const translateSchema = {
  type: 'object',
  properties: { texts: { type: 'array', items: { type: 'string' } } },
  required: ['texts'],
  additionalProperties: false
};
const LANGUAGE_NAMES = { ru: 'Russian', kk: 'Kazakh' };
const TRANSLATE_PROVIDERS = ['groq', 'gemini'];

function translatePrompt(input) {
  return `Translate every string in TEXTS from English into ${LANGUAGE_NAMES[input.language]} for a school student's feedback.
Keep the meaning, tone and length. Do not add, remove, merge or reorder items. Keep numbers, quotation marks and any English words inside quotes exactly as they are.
Return JSON only: {"texts":["..."]} with exactly ${input.texts.length} strings in the same order.

TEXTS:
${JSON.stringify(input.texts)}`;
}

function normalizeTranslation(result, input) {
  if (!result || !Array.isArray(result.texts) || result.texts.length !== input.texts.length || result.texts.some(item => typeof item !== 'string')) {
    throw new Error('Модель вернула неполный перевод.');
  }
  return { texts: result.texts.map((item, index) => item.trim() || input.texts[index]) };
}

// The small Cloudflare model loses criteria when asked for everything at once,
// so every criterion gets its own small request, plus one for remarks and the summary.
const criterionSchema = {
  type: 'object',
  properties: { score: { type: 'integer' }, comment: { type: 'string' } },
  required: ['score', 'comment'],
  additionalProperties: false
};
const summarySchema = {
  type: 'object',
  properties: {
    remarks: assessmentSchema.properties.remarks,
    strengths: { type: 'string' }, priorities: { type: 'string' }, next: { type: 'string' }
  },
  required: ['remarks', 'strengths', 'priorities', 'next'],
  additionalProperties: false
};

function taskContext(input) {
  return JSON.stringify({ topic: input.topic || '', genre: input.genre || '', level: input.level || '', task: input.task || '', expectedLength: input.expectedLength || '' });
}

function criterionPrompt(input, index) {
  const criterion = input.criteria[index];
  return `You are assisting a teacher, not replacing their judgement. Assess the student text against ONE criterion only.
Write the comment in English as one short sentence of at most 18 words. Use an integer score from 0 to ${criterion.max}.
Return JSON only: {"score":0,"comment":"..."}

TASK_CONTEXT:
${taskContext(input)}

CRITERION:
${JSON.stringify({ name: criterion.name, max: criterion.max, descriptors: compactDescriptors(criterion.descriptors) })}

STUDENT_TEXT:
${input.text}`;
}

function summaryPrompt(input) {
  return `You are assisting a teacher. Review the student text.
Return no more than 3 remarks; every "quote" must be copied character-for-character from STUDENT_TEXT. Keep strengths, priorities and next to at most 20 words each, in English.
Return JSON only: {"remarks":[{"quote":"exact source quote","correction":"...","explanation":"...","type":"error|style|uncertain","include":true}],"strengths":"...","priorities":"...","next":"..."}

TASK_CONTEXT:
${taskContext(input)}

CRITERIA: ${JSON.stringify(input.criteria.map(criterion => criterion.name))}

STUDENT_TEXT:
${input.text}`;
}

async function cloudflareAssessSplit({ input, env, fetchImpl }) {
  const jobs = [
    ...input.criteria.map((_, index) => () => cloudflareAssess({ prompt: criterionPrompt(input, index), schema: criterionSchema, maxTokens: 300, env, fetchImpl })),
    () => cloudflareAssess({ prompt: summaryPrompt(input), schema: summarySchema, maxTokens: 900, env, fetchImpl })
  ];
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; results[i] = await jobs[i](); }
  }));
  const summary = results.pop();
  return { criteria: results.map((item, index) => ({ index, score: item?.score, comment: item?.comment })), ...summary };
}

async function cloudflareAssess({ prompt, schema = assessmentSchema, maxTokens = 1500, env, fetchImpl }) {
  const { accountId, token } = cloudflareCredentials(env);
  const model = env.CLOUDFLARE_ASSESS_MODEL || DEFAULT_CLOUDFLARE_ASSESS_MODEL;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
  const options = requestBody => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(requestBody)
  });
  const request = {
    prompt,
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: 'json_schema', json_schema: schema }
  };
  let response = await fetchImpl(endpoint, options(request));
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const message = errorBody?.error?.message || errorBody?.errors?.[0]?.message || `HTTP ${response.status}`;
    const mayAccept = model === CLOUDFLARE_LLAMA32_MODEL && env.CLOUDFLARE_LLAMA32_AGREED === 'true' && /Model Agreement/i.test(message);
    if (!mayAccept) throw new Error(`Cloudflare: ${message}`);
    await responseJson(await fetchImpl(endpoint, options({ prompt: 'agree' })), 'Cloudflare');
    response = await fetchImpl(endpoint, options(request));
  }
  const body = await responseJson(response, 'Cloudflare');
  const text = body?.result?.response ?? body?.result;
  if (text && typeof text === 'object' && !Array.isArray(text)) return text;
  if (typeof text !== 'string') throw new Error('Cloudflare не вернул текстовый результат.');
  return parseJson(text, 'Cloudflare');
}

function configured(provider, env) {
  return provider === 'vision'
    ? Boolean(env.GOOGLE_CLOUD_VISION_API_KEY)
    : provider === 'groq'
    ? Boolean(env.GROQ_API_KEY)
    : provider === 'gemini'
    ? Boolean(env.GEMINI_API_KEY)
    : provider === 'cloudflare'
      ? Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)
      : false;
}

export function availableProviders(env = process.env) {
  return ['groq', 'gemini', 'cloudflare'].filter(provider => configured(provider, env));
}

// Providers usable for text recognition, in the order they are tried (no secrets exposed).
export function ocrProviders(env = process.env) {
  return ['vision', 'cloudflare', 'gemini'].filter(provider => configured(provider, env));
}

export function selectProvider(requested, env = process.env) {
  const allowed = ['auto', 'groq', 'gemini', 'cloudflare'];
  if (!allowed.includes(requested || 'auto') && requested !== 'vision') throw new Error('Неизвестный AI-провайдер.');
  if (requested && requested !== 'auto') {
    if (!configured(requested, env)) throw new Error(`Провайдер ${requested} не настроен на сервере.`);
    return requested;
  }
  const preferred = allowed.includes(env.AI_PROVIDER) ? env.AI_PROVIDER : 'gemini';
  if (preferred !== 'auto' && configured(preferred, env)) return preferred;
  const first = availableProviders(env)[0];
  if (!first) throw new Error('На сервере не настроен ни один AI-провайдер.');
  return first;
}

function selectProviderForAction(action, requested, env) {
  if ((!requested || requested === 'auto') && action === 'recognize') {
    if (configured('vision', env)) return 'vision';
    if (configured('cloudflare', env)) return 'cloudflare';
    if (configured('gemini', env)) return 'gemini';
  }
  if ((!requested || requested === 'auto') && action === 'translate') {
    const first = TRANSLATE_PROVIDERS.find(name => configured(name, env));
    if (!first) throw new Error('Для перевода на сервере не настроен ни один AI-провайдер.');
    return first;
  }
  // Comments and feedback: Groq first whenever it is configured, regardless of AI_PROVIDER.
  if ((!requested || requested === 'auto') && action === 'assess' && configured('groq', env)) return 'groq';
  return selectProvider(requested, env);
}

export function parseImageDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) throw new Error('Поддерживаются изображения JPG и PNG в формате data URL.');
  const byteLength = Buffer.from(match[2], 'base64').byteLength;
  if (!byteLength || byteLength > 4 * 1024 * 1024) throw new Error('Для AI-распознавания изображение должно быть не больше 4 МБ.');
  return { mimeType: match[1], base64: match[2], byteLength };
}

function normalizeRecognition(result) {
  if (!result || typeof result.text !== 'string' || !result.text.trim()) throw new Error('Модель не вернула распознанный текст.');
  return {
    text: result.text.trim(),
    warnings: Array.isArray(result.warnings) ? result.warnings.filter(item => typeof item === 'string').slice(0, 10) : []
  };
}

function normalizeAssessment(result, input) {
  if (!result || !Array.isArray(result.criteria) || result.criteria.length !== input.criteria.length) throw new Error('Модель вернула неполный набор критериев.');
  const seen = new Set();
  const criteria = result.criteria.map(item => {
    const index = Number(item.index);
    const source = input.criteria[index];
    const score = Number(item.score);
    if (!Number.isInteger(index) || !source || seen.has(index) || !Number.isInteger(score) || score < 0 || score > source.max || typeof item.comment !== 'string' || !item.comment.trim()) {
      throw new Error('Модель вернула некорректный балл или комментарий.');
    }
    seen.add(index);
    return { index, score, comment: item.comment.trim() };
  }).sort((a, b) => a.index - b.index);
  const remarks = (Array.isArray(result.remarks) ? result.remarks : []).filter(item =>
    item && typeof item.quote === 'string' && item.quote && input.text.includes(item.quote) &&
    typeof item.correction === 'string' && typeof item.explanation === 'string'
  ).slice(0, 20).map(item => ({
    quote: item.quote,
    correction: item.correction.trim(),
    explanation: item.explanation.trim(),
    type: ['error', 'style', 'uncertain'].includes(item.type) ? item.type : 'uncertain',
    include: item.include !== false
  }));
  for (const field of ['strengths', 'priorities', 'next']) if (typeof result[field] !== 'string' || !result[field].trim()) throw new Error(`Модель не заполнила поле ${field}.`);
  return { criteria, remarks, strengths: result.strengths.trim(), priorities: result.priorities.trim(), next: result.next.trim() };
}

// With provider "auto" the preferred provider is tried first, the others only if it fails.
// Not raced in parallel: the Gemini free tier allows only 20 requests per day.
const FIRST_PROVIDER_MS = 20000; // leave time for the fallback provider
const VALIDATION_ERRORS = /Для оценивания нужен|Для оценивания требуется|Критерии имеют|Поддерживаются изображения|не больше 4 МБ|Для перевода нужен|Неизвестное AI-действие/;

export async function runAI(request) {
  const { action, provider: requestedProvider = 'auto', env = process.env } = request;
  const first = selectProviderForAction(action, requestedProvider, env);
  const auto = !requestedProvider || requestedProvider === 'auto';
  const pool = action === 'recognize' ? ['vision', 'cloudflare', 'gemini'].filter(name => configured(name, env)) : action === 'translate' ? TRANSLATE_PROVIDERS.filter(name => configured(name, env)) : availableProviders(env);
  const providers = auto ? [first, ...pool.filter(name => name !== first)] : [first];
  const baseFetch = request.fetchImpl || fetch;
  const startedAt = Date.now();
  const attempt = (provider, index) => {
    const left = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    const fetchImpl = (url, options = {}) => baseFetch(url, { ...options, signal: AbortSignal.timeout(Math.max(1000, index < providers.length - 1 ? Math.min(left - 500, FIRST_PROVIDER_MS) : left - 500)) });
    return runWithProvider(provider, { ...request, fetchImpl });
  };
  return new Promise((resolve, reject) => {
    let pending = 0, finished = false;
    const errors = [];
    let lastMessage = '';
    const settle = (fn, value) => { if (!finished) { finished = true; fn(value); } };
    const launch = (provider, index = providers.indexOf(provider)) => {
      pending++;
      attempt(provider, index).then(result => settle(resolve, result), error => {
        if (VALIDATION_ERRORS.test(error.message)) return settle(reject, error);
        const message = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'превышено время ожидания' : error.message;
        console.error(`CriteriaLab ${provider} failed:`, message);
        lastMessage = message;
        errors.push(`${provider}: ${message}`);
        const next = providers[index + 1];
        if (next && !finished) launch(next, index + 1);
      }).finally(() => {
        pending--;
        if (pending === 0 && !finished) settle(reject, new Error(providers.length > 1 ? `Все AI-провайдеры не ответили. ${errors.join(' | ')}` : lastMessage));
      });
    };
    launch(providers[0], 0);
  });
}

async function runWithProvider(provider, { action, imageDataUrl, input, env = process.env, fetchImpl = fetch }) {
  if (action === 'recognize') {
    if (provider === 'groq') throw new Error('Неизвестное AI-действие: Groq используется только для комментариев.');
    const image = parseImageDataUrl(imageDataUrl);
    const result = provider === 'vision'
      ? await visionRecognize({ image, env, fetchImpl })
      : provider === 'gemini'
      ? await geminiGenerate({ prompt: recognitionPrompt, image, schema: recognitionSchema, env, fetchImpl })
      : await cloudflareRecognize({ prompt: recognitionPrompt, image, env, fetchImpl });
    return { provider, action, result: normalizeRecognition(result) };
  }
  if (action === 'assess') {
    if (provider === 'vision') throw new Error('Неизвестное AI-действие: Google Vision выполняет только распознавание.');
    if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 50000) throw new Error('Для оценивания нужен подтверждённый текст до 50 000 символов.');
    if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 30) throw new Error('Для оценивания требуется от 1 до 30 критериев.');
    input.criteria.forEach(criterion => {
      if (!criterion || typeof criterion.name !== 'string' || !Number.isInteger(criterion.max) || criterion.max < 1 || criterion.max > 20 || !Array.isArray(criterion.descriptors)) throw new Error('Критерии имеют неверный формат.');
    });
    const prompt = assessmentPrompt(input);
    const result = provider === 'groq'
      ? await groqAssess({ prompt, env, fetchImpl })
      : provider === 'gemini'
      ? await geminiGenerate({ prompt, schema: assessmentSchema, env, fetchImpl })
      : await cloudflareAssessSplit({ input, env, fetchImpl });
    return { provider, action, result: normalizeAssessment(result, input) };
  }
  if (action === 'translate') {
    if (!input || !LANGUAGE_NAMES[input.language] || !Array.isArray(input.texts) || input.texts.length < 1 || input.texts.length > 200 || input.texts.some(item => typeof item !== 'string') || JSON.stringify(input.texts).length > 30000) {
      throw new Error('Для перевода нужен язык ru или kk и до 200 текстов.');
    }
    if (!TRANSLATE_PROVIDERS.includes(provider)) throw new Error('Неизвестное AI-действие: этот провайдер не выполняет перевод.');
    const prompt = translatePrompt(input);
    const result = provider === 'groq'
      ? await groqAssess({ prompt, env, fetchImpl })
      : await geminiGenerate({ prompt, schema: translateSchema, env, fetchImpl });
    return { provider, action, result: normalizeTranslation(result, input) };
  }
  throw new Error('Неизвестное AI-действие.');
}
