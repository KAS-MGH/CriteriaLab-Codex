import assert from 'node:assert/strict';
import { compactDescriptors, availableProviders, parseImageDataUrl, runAI, selectProvider } from './netlify/functions/lib/ai-providers.mjs';

const tinyImage = 'data:image/png;base64,iVBORw0KGgo=';
assert.equal(parseImageDataUrl(tinyImage).mimeType, 'image/png');
assert.deepEqual(availableProviders({ GEMINI_API_KEY: 'g' }), ['gemini']);
assert.equal(selectProvider('auto', { AI_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' }), 'cloudflare');

const geminiFetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  assert.equal(request.input[1].mime_type, 'image/png');
  assert.equal(request.response_format.mime_type, 'application/json');
  assert.equal(request.store, false);
  return new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ text: 'Original mistak.', warnings: [] }) }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const recognized = await runAI({ action: 'recognize', provider: 'gemini', imageDataUrl: tinyImage, env: { GEMINI_API_KEY: 'secret' }, fetchImpl: geminiFetch });
assert.equal(recognized.result.text, 'Original mistak.');

let automaticOcrUrl = '';
const automaticOcr = await runAI({
  action: 'recognize', provider: 'auto', imageDataUrl: tinyImage,
  env: { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'gemini', CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' },
  fetchImpl: async url => {
    automaticOcrUrl ||= url; // providers now run in parallel; the preferred one is called first
    return new Response(JSON.stringify({ result: { answer: 'Cloudflare OCR text.' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
});
assert.equal(automaticOcr.provider, 'cloudflare', 'automatic OCR must prefer the specialized Cloudflare model');
assert.match(automaticOcrUrl, /api\.cloudflare\.com/);

const criteria = [{ name: 'Accuracy', max: 4, descriptors: ['none', 'low', 'partial', 'good', 'excellent'] }];
const cfReply = request => {
  const props = request.response_format.json_schema.properties;
  const result = props.score
    ? { score: 3, comment: 'Хорошая работа.' }
    : { remarks: [{ quote: 'mistak', correction: 'mistake', explanation: 'Spelling.', type: 'error', include: true }, { quote: 'invented', correction: '', explanation: '', type: 'error' }], strengths: 'Ясная мысль.', priorities: 'Проверить написание.', next: 'Вычитать текст.' };
  return new Response(JSON.stringify({ result: { response: JSON.stringify(result) } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
let cfCalls = 0;
const cloudflareFetch = async (_url, options) => {
  assert.match(options.headers.authorization, /^Bearer /);
  const request = JSON.parse(options.body);
  cfCalls++;
  assert.equal(request.response_format.type, 'json_schema');
  return cfReply(request);
};
const assessed = await runAI({ action: 'assess', provider: 'cloudflare', input: { text: 'Original mistak.', criteria, feedbackLanguage: 'ru' }, env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }, fetchImpl: cloudflareFetch });
assert.equal(assessed.result.criteria[0].score, 3);
assert.equal(cfCalls, 2, 'Cloudflare must send one request per criterion plus one for remarks and summary');
assert.equal(assessed.result.remarks.length, 1, 'remarks without an exact source quote must be rejected');

await assert.rejects(
  runAI({ action: 'feedback', provider: 'cloudflare', input: { score: 16, max: 20, criteria: [], feedbackLanguage: 'kk' }, env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }, fetchImpl: async () => { throw new Error('no network call expected'); } }),
  /Неизвестное AI-действие/,
  'AI feedback generation and translation must be removed from the backend'
);

let agreed = false;
const agreementFetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  if (request.prompt === 'agree') { agreed = true; return new Response(JSON.stringify({ result: { response: 'agreed' } }), { status: 200, headers: { 'content-type': 'application/json' } }); }
  if (!agreed) return new Response(JSON.stringify({ errors: [{ message: 'Model Agreement: submit agree' }] }), { status: 403, headers: { 'content-type': 'application/json' } });
  return cfReply(request);
};
const agreementResult = await runAI({ action: 'assess', provider: 'cloudflare', input: { text: 'Original mistak.', criteria, feedbackLanguage: 'ru' }, env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ASSESS_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct', CLOUDFLARE_LLAMA32_AGREED: 'true' }, fetchImpl: agreementFetch });
assert.equal(agreementResult.result.criteria[0].score, 3);
assert.ok(agreed);

const plainTextFetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  assert.equal(request.task, 'query');
  assert.match(request.image, /^data:image\/png;base64,/);
  assert.equal(request.reasoning, false);
  assert.equal(request.stream, false);
  return new Response(JSON.stringify({ result: { answer: 'Handwritten text without JSON.' } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const plainTextResult = await runAI({ action: 'recognize', provider: 'cloudflare', imageDataUrl: tinyImage, env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }, fetchImpl: plainTextFetch });
assert.equal(plainTextResult.result.text, 'Handwritten text without JSON.');
assert.equal(plainTextResult.result.warnings.length, 1);

const descriptiveFetch = async () => new Response(JSON.stringify({ result: { answer: 'The image shows lined paper.\n\nHere is the transcribed text:\n\nStudent original text.\n\nThe text is written clearly and presents an argument.' } }), { status: 200, headers: { 'content-type': 'application/json' } });
const descriptiveResult = await runAI({ action: 'recognize', provider: 'cloudflare', imageDataUrl: tinyImage, env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }, fetchImpl: descriptiveFetch });
assert.equal(descriptiveResult.result.text, 'Student original text.');

const markedFetch = async () => new Response(JSON.stringify({ result: { answer: '<TRANSCRIPTION>\nExact marked text.\n</TRANSCRIPTION>' } }), { status: 200, headers: { 'content-type': 'application/json' } });
const markedResult = await runAI({ action: 'recognize', provider: 'cloudflare', imageDataUrl: tinyImage, env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }, fetchImpl: markedFetch });
assert.equal(markedResult.result.text, 'Exact marked text.');

const nestedFetch = async () => new Response(JSON.stringify({ result: { result: { answer: 'Nested Cloudflare answer.' }, usage: { total_tokens: 10 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
const nestedResult = await runAI({ action: 'recognize', provider: 'cloudflare', imageDataUrl: tinyImage, env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }, fetchImpl: nestedFetch });
assert.equal(nestedResult.result.text, 'Nested Cloudflare answer.');

const nestedJsonFetch = async () => new Response(JSON.stringify({ result: { result: { answer: JSON.stringify({ text: 'Clean JSON transcription.' }) }, usage: {} } }), { status: 200, headers: { 'content-type': 'application/json' } });
const nestedJsonResult = await runAI({ action: 'recognize', provider: 'cloudflare', imageDataUrl: tinyImage, env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }, fetchImpl: nestedJsonFetch });
assert.equal(nestedJsonResult.result.text, 'Clean JSON transcription.');

// Fallback: a weak Cloudflare answer must fall through to Gemini when provider is auto.
const fallbackInput = { text: "I like school.", criteria: [{ name: "Content", max: 5, descriptors: ["x"] }] };
const fallbackFetch = async url => String(url).includes("cloudflare")
  ? new Response(JSON.stringify({ result: { response: { criteria: [], remarks: [], strengths: "", priorities: "", next: "" } } }), { status: 200, headers: { "content-type": "application/json" } })
  : new Response(JSON.stringify({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ criteria: [{ index: 0, score: 4, comment: "Good." }], remarks: [], strengths: "a", priorities: "b", next: "c" }) }] }] }), { status: 200, headers: { "content-type": "application/json" } });
const fallbackEnv = { AI_PROVIDER: "cloudflare", CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", GEMINI_API_KEY: "g" };
const fallbackResult = await runAI({ action: "assess", provider: "auto", input: fallbackInput, env: fallbackEnv, fetchImpl: fallbackFetch });
assert.equal(fallbackResult.provider, "gemini");
await assert.rejects(runAI({ action: "assess", provider: "cloudflare", input: fallbackInput, env: fallbackEnv, fetchImpl: fallbackFetch }), /Модель вернула/);

// PDF imports repeat one band text for several scores: merge them.
assert.deepEqual(compactDescriptors(['', 'weak', 'weak', 'weak', 'good', 'good']), ['1-3: weak', '4-5: good']);
assert.ok(compactDescriptors(['x'.repeat(900)])[0].length < 310);
// Google Cloud Vision is the preferred OCR; key goes in a header, never in the URL; assess never uses it.
let visionUrl = '', visionKeyHeader = '';
const visionEnv = { GOOGLE_CLOUD_VISION_API_KEY: 'vk', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' };
const visionResult = await runAI({ action: 'recognize', provider: 'auto', imageDataUrl: tinyImage, env: visionEnv, fetchImpl: async (url, options) => {
  visionUrl = url; visionKeyHeader = options.headers['x-goog-api-key'];
  assert.equal(JSON.parse(options.body).requests[0].features[0].type, 'DOCUMENT_TEXT_DETECTION');
  return new Response(JSON.stringify({ responses: [{ fullTextAnnotation: { text: 'Vision text.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
} });
assert.equal(visionResult.provider, 'vision');
assert.equal(visionResult.result.text, 'Vision text.');
assert.ok(!visionUrl.includes('vk') && visionKeyHeader === 'vk');
const visionFallback = await runAI({ action: 'recognize', provider: 'auto', imageDataUrl: tinyImage, env: visionEnv, fetchImpl: async url => String(url).includes('vision.googleapis')
  ? new Response(JSON.stringify({ responses: [{}] }), { status: 200, headers: { 'content-type': 'application/json' } })
  : new Response(JSON.stringify({ result: { answer: 'Cloudflare backup.' } }), { status: 200, headers: { 'content-type': 'application/json' } }) });
assert.equal(visionFallback.provider, 'cloudflare');
await assert.rejects(runAI({ action: 'assess', provider: 'vision', input: fallbackInput, env: visionEnv, fetchImpl: async () => { throw new Error('no call'); } }), /только распознавание/);

// Groq goes first for assessment when configured, even if AI_PROVIDER says otherwise; Cloudflare is the last resort.
const groqOk = { criteria: [{ index: 0, score: 4, comment: 'Groq comment.' }], remarks: [], strengths: 'a', priorities: 'b', next: 'c' };
const urls = [];
const groqEnv = { AI_PROVIDER: 'cloudflare', GROQ_API_KEY: 'q', GEMINI_API_KEY: 'g', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' };
const groqResult = await runAI({ action: 'assess', provider: 'auto', input: fallbackInput, env: groqEnv, fetchImpl: async (url, options) => {
  urls.push(String(url));
  assert.equal(JSON.parse(options.body).response_format.type, 'json_object');
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(groqOk) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
} });
assert.equal(groqResult.provider, 'groq');
assert.equal(urls.length, 1);
assert.match(urls[0], /api.groq.com/);
const groqFallback = await runAI({ action: 'assess', provider: 'auto', input: fallbackInput, env: groqEnv, fetchImpl: async (url, o) => String(url).includes('groq')
  ? new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }) : fallbackFetch(url, o) });
assert.equal(groqFallback.provider, 'gemini', 'a Groq failure must fall through to Gemini');
const noGroqOcr = await runAI({ action: 'recognize', provider: 'auto', imageDataUrl: tinyImage, env: { GROQ_API_KEY: 'q', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' }, fetchImpl: async url => { assert.doesNotMatch(String(url), /groq/); return new Response(JSON.stringify({ result: { answer: 'ok text' } }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
assert.equal(noGroqOcr.provider, 'cloudflare');
assert.match(compactDescriptors(['a  b', 'a b', 'c'])[0], /^0-1: a b$/);

// Translation to Russian/Kazakh: Groq first, Gemini as backup, strict shape checks.
const trInput = { language: 'kk', texts: ['Good work.', 'Fix spelling.'] };
const trEnv = { GROQ_API_KEY: 'q', GEMINI_API_KEY: 'g' };
const groqTr = texts => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ texts }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const trOk = await runAI({ action: 'translate', provider: 'auto', input: trInput, env: trEnv, fetchImpl: async (url, o) => { assert.match(String(url), /api.groq.com/); assert.match(JSON.parse(o.body).messages[0].content, /Kazakh/); return groqTr(['A', 'B']); } });
assert.equal(trOk.provider, 'groq');
assert.deepEqual(trOk.result.texts, ['A', 'B']);
const trFallback = await runAI({ action: 'translate', provider: 'auto', input: trInput, env: trEnv, fetchImpl: async url => String(url).includes('groq')
  ? groqTr(['only one'])
  : new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ texts: ['X', 'Y'] }) }] }] }), { status: 200, headers: { 'content-type': 'application/json' } }) });
assert.equal(trFallback.provider, 'gemini', 'a bad Groq translation must fall through to Gemini');
await assert.rejects(runAI({ action: 'translate', provider: 'auto', input: { language: 'fr', texts: ['a'] }, env: trEnv, fetchImpl: async () => { throw new Error('no call'); } }), /Для перевода нужен/);

// Groq: when the default model is not available to the key, the function picks an available one.
const modelCalls = [];
const autoModel = await runAI({ action: 'translate', provider: 'groq', input: trInput, env: { GROQ_API_KEY: 'q' }, fetchImpl: async (url, o) => {
  if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.1-8b-instant' }, { id: 'openai/gpt-oss-120b' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const model = JSON.parse(o.body).model; modelCalls.push(model);
  return model === 'openai/gpt-oss-120b' ? groqTr(['A', 'B']) : new Response(JSON.stringify({ error: { message: 'The model `' + model + '` does not exist or you do not have access to it.' } }), { status: 404, headers: { 'content-type': 'application/json' } });
} });
assert.deepEqual(autoModel.result.texts, ['A', 'B']);
assert.deepEqual(modelCalls, ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']);
console.log('PASS: provider selection, image validation, Gemini recognition, Cloudflare assessment, no AI feedback or translation, and explicit license handling');
