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
const cloudflareFetch = async (_url, options) => {
  assert.match(options.headers.authorization, /^Bearer /);
  const request = JSON.parse(options.body);
  assert.equal(request.max_tokens, 1500);
  assert.equal(request.response_format.type, 'json_schema');
  const result = { criteria: [{ index: 0, score: 3, comment: 'Хорошая работа.' }], remarks: [{ quote: 'mistak', correction: 'mistake', explanation: 'Spelling.', type: 'error', include: true }, { quote: 'invented', correction: '', explanation: '', type: 'error' }], strengths: 'Ясная мысль.', priorities: 'Проверить написание.', next: 'Вычитать текст.' };
  return new Response(JSON.stringify({ result: { response: JSON.stringify(result) } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const assessed = await runAI({ action: 'assess', provider: 'cloudflare', input: { text: 'Original mistak.', criteria, feedbackLanguage: 'ru' }, env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }, fetchImpl: cloudflareFetch });
assert.equal(assessed.result.criteria[0].score, 3);
assert.equal(assessed.result.remarks.length, 1, 'remarks without an exact source quote must be rejected');

await assert.rejects(
  runAI({ action: 'feedback', provider: 'cloudflare', input: { score: 16, max: 20, criteria: [], feedbackLanguage: 'kk' }, env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }, fetchImpl: async () => { throw new Error('no network call expected'); } }),
  /Неизвестное AI-действие/,
  'AI feedback generation and translation must be removed from the backend'
);

let agreementCalls = 0;
const agreementFetch = async (_url, options) => {
  agreementCalls++;
  const request = JSON.parse(options.body);
  if (agreementCalls === 1) return new Response(JSON.stringify({ errors: [{ message: 'Model Agreement: submit agree' }] }), { status: 403, headers: { 'content-type': 'application/json' } });
  if (agreementCalls === 2) { assert.equal(request.prompt, 'agree'); return new Response(JSON.stringify({ result: { response: 'agreed' } }), { status: 200, headers: { 'content-type': 'application/json' } }); }
  const result = { criteria: [{ index: 0, score: 3, comment: 'Хорошая работа.' }], remarks: [], strengths: 'Ясная мысль.', priorities: 'Проверить написание.', next: 'Вычитать текст.' };
  return new Response(JSON.stringify({ result: { response: JSON.stringify(result) } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const agreementResult = await runAI({ action: 'assess', provider: 'cloudflare', input: { text: 'Original mistak.', criteria, feedbackLanguage: 'ru' }, env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ASSESS_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct', CLOUDFLARE_LLAMA32_AGREED: 'true' }, fetchImpl: agreementFetch });
assert.equal(agreementResult.result.criteria[0].score, 3);
assert.equal(agreementCalls, 3);

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
await assert.rejects(runAI({ action: "assess", provider: "cloudflare", input: fallbackInput, env: fallbackEnv, fetchImpl: fallbackFetch }), /неполный набор/);

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
console.log('PASS: provider selection, image validation, Gemini recognition, Cloudflare assessment, no AI feedback or translation, and explicit license handling');
