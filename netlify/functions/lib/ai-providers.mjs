const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_CLOUDFLARE_OCR_MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const DEFAULT_CLOUDFLARE_ASSESS_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const CLOUDFLARE_LLAMA32_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

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

const feedbackSchema = {
  type: 'object',
  properties: {
    assessment: { type: 'string' },
    improvements: { type: 'string' },
    next: { type: 'string' }
  },
  required: ['assessment', 'improvements', 'next'],
  additionalProperties: false
};

function assessmentPrompt(input) {
  const language = input.feedbackLanguage === 'kk' ? 'Kazakh' : input.feedbackLanguage === 'en' ? 'English' : 'Russian';
  return `You are assisting a teacher, not replacing their judgement. Assess only against the supplied task and rubric.
Write learner-facing comments in ${language}. Do not invent requirements that are missing from the task.
Every quoted fragment must be copied character-for-character from STUDENT_TEXT. Use integer scores within each criterion maximum.
Be concise: use one short sentence of at most 18 words per criterion, return no more than 3 remarks, and keep strengths, priorities and next to at most 20 words each.
Return JSON only, with this shape:
{"criteria":[{"index":0,"score":0,"comment":"..."}],"remarks":[{"quote":"exact source quote","correction":"...","explanation":"...","type":"error|style|uncertain","include":true}],"strengths":"...","priorities":"...","next":"..."}

TASK_CONTEXT:
${JSON.stringify({ topic: input.topic || '', genre: input.genre || '', level: input.level || '', task: input.task || '', expectedLength: input.expectedLength || '' })}

RUBRIC:
${JSON.stringify(input.criteria.map((criterion, index) => ({ index, name: criterion.name, max: criterion.max, descriptors: criterion.descriptors })))}

STUDENT_TEXT:
${input.text}`;
}

function feedbackPrompt(input) {
  const language = input.feedbackLanguage === 'kk' ? 'Kazakh' : input.feedbackLanguage === 'en' ? 'English' : 'Russian';
  return `You are turning a teacher-approved assessment into clear learner-facing feedback in ${language}.
Do not change, recalculate or question any score. Use only the supplied approved notes and student text.
Translate every learner-facing prose passage into ${language}, even when the approved teacher notes were written in another language. The assessment, improvements and next-step sections must be consistently written in ${language}.
Keep each exact student quotation and its concrete corrected wording character-for-character in the original language. Do not translate individual quoted words, corrections, endings or other language forms being analysed. Translate the explanation around them into ${language}.
Outside those exact language examples, leave no sentences in the source language. Proper names may remain unchanged.
Connect repetitive notes, expand very short advice into useful explanations, and add practical examples of strategies or language choices.
For example, a note such as "use linking words" may be expanded with suitable examples such as "moreover", "in conclusion", "thus" or "nevertheless".
Do not invent errors, achievements, quotations or task requirements. Exact student quotations may only come from APPROVED_REMARKS.
Keep the tone supportive and specific. Return plain text inside JSON with three sections and no score header.
Return JSON only: {"assessment":"...","improvements":"...","next":"..."}

CONTEXT:
${JSON.stringify({ topic: input.topic || '', genre: input.genre || '', level: input.level || '', task: input.task || '' })}

APPROVED_SCORE:
${JSON.stringify({ score: input.score, max: input.max })}

APPROVED_CRITERIA:
${JSON.stringify(input.criteria)}

APPROVED_REMARKS:
${JSON.stringify(input.remarks || [])}

APPROVED_SUMMARY_FIELDS:
${JSON.stringify({ strengths: input.strengths || '', priorities: input.priorities || '', next: input.next || '' })}

STUDENT_TEXT_FOR_CONTEXT_ONLY:
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
  const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey, 'api-revision': '2026-05-20' },
    body: JSON.stringify({
      model,
      input,
      response_format: { type: 'text', mime_type: 'application/json', schema },
      generation_config: { temperature: 0 },
      store: false
    })
  });
  const body = await responseJson(response, 'Gemini');
  if (body?.status && body.status !== 'completed') throw new Error(`Gemini не завершил запрос: ${body.status}.`);
  return parseJson(geminiText(body), 'Gemini');
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

async function cloudflareAssess({ prompt, schema = assessmentSchema, env, fetchImpl }) {
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
    max_tokens: 900,
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
  return provider === 'gemini'
    ? Boolean(env.GEMINI_API_KEY)
    : provider === 'cloudflare'
      ? Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)
      : false;
}

export function availableProviders(env = process.env) {
  return ['gemini', 'cloudflare'].filter(provider => configured(provider, env));
}

export function selectProvider(requested, env = process.env) {
  const allowed = ['auto', 'gemini', 'cloudflare'];
  if (!allowed.includes(requested || 'auto')) throw new Error('Неизвестный AI-провайдер.');
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

function normalizeFeedback(result) {
  if (!result || typeof result !== 'object') throw new Error('Модель не вернула отзыв.');
  const normalized = {};
  for (const field of ['assessment', 'improvements', 'next']) {
    if (typeof result[field] !== 'string' || !result[field].trim()) throw new Error(`Модель не заполнила раздел ${field}.`);
    normalized[field] = result[field].trim().slice(0, 6000);
  }
  return normalized;
}

export async function runAI({ action, provider: requestedProvider = 'auto', imageDataUrl, input, env = process.env, fetchImpl = fetch }) {
  const provider = selectProvider(requestedProvider, env);
  if (action === 'recognize') {
    const image = parseImageDataUrl(imageDataUrl);
    const result = provider === 'gemini'
      ? await geminiGenerate({ prompt: recognitionPrompt, image, schema: recognitionSchema, env, fetchImpl })
      : await cloudflareRecognize({ prompt: recognitionPrompt, image, env, fetchImpl });
    return { provider, action, result: normalizeRecognition(result) };
  }
  if (action === 'assess') {
    if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 50000) throw new Error('Для оценивания нужен подтверждённый текст до 50 000 символов.');
    if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 30) throw new Error('Для оценивания требуется от 1 до 30 критериев.');
    input.criteria.forEach(criterion => {
      if (!criterion || typeof criterion.name !== 'string' || !Number.isInteger(criterion.max) || criterion.max < 1 || criterion.max > 20 || !Array.isArray(criterion.descriptors)) throw new Error('Критерии имеют неверный формат.');
    });
    const prompt = assessmentPrompt(input);
    const result = provider === 'gemini'
      ? await geminiGenerate({ prompt, schema: assessmentSchema, env, fetchImpl })
      : await cloudflareAssess({ prompt, env, fetchImpl });
    return { provider, action, result: normalizeAssessment(result, input) };
  }
  if (action === 'feedback') {
    if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 50000) throw new Error('Для отзыва нужен подтверждённый текст до 50 000 символов.');
    if (!['en', 'ru', 'kk'].includes(input.feedbackLanguage)) throw new Error('Для отзыва нужно выбрать язык.');
    if (!Number.isInteger(input.score) || !Number.isInteger(input.max) || input.score < 0 || input.max < 1 || input.score > input.max) throw new Error('Итоговая оценка имеет неверный формат.');
    if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 30) throw new Error('Для отзыва требуется от 1 до 30 критериев.');
    input.criteria.forEach(criterion => {
      if (!criterion || typeof criterion.name !== 'string' || !Number.isInteger(criterion.score) || !Number.isInteger(criterion.max) || criterion.score < 0 || criterion.score > criterion.max || typeof criterion.comment !== 'string') throw new Error('Утверждённые критерии имеют неверный формат.');
    });
    const prompt = feedbackPrompt(input);
    const result = provider === 'gemini'
      ? await geminiGenerate({ prompt, schema: feedbackSchema, env, fetchImpl })
      : await cloudflareAssess({ prompt, schema: feedbackSchema, env, fetchImpl });
    return { provider, action, result: normalizeFeedback(result) };
  }
  throw new Error('Неизвестное AI-действие.');
}
