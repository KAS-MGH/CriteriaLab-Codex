import assert from 'node:assert/strict';
import { availableProviders, parseImageDataUrl, runAI, selectProvider } from './netlify/functions/lib/ai-providers.mjs';

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

const criteria = [{ name: 'Accuracy', max: 4, descriptors: ['none', 'low', 'partial', 'good', 'excellent'] }];
const cloudflareFetch = async (_url, options) => {
  assert.match(options.headers.authorization, /^Bearer /);
  const request = JSON.parse(options.body);
  assert.equal(request.max_tokens, 900);
  assert.equal(request.response_format.type, 'json_schema');
  const result = { criteria: [{ index: 0, score: 3, comment: 'Хорошая работа.' }], remarks: [{ quote: 'mistak', correction: 'mistake', explanation: 'Spelling.', type: 'error', include: true }, { quote: 'invented', correction: '', explanation: '', type: 'error' }], strengths: 'Ясная мысль.', priorities: 'Проверить написание.', next: 'Вычитать текст.' };
  return new Response(JSON.stringify({ result: { response: JSON.stringify(result) } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const assessed = await runAI({ action: 'assess', provider: 'cloudflare', input: { text: 'Original mistak.', criteria, feedbackLanguage: 'ru' }, env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }, fetchImpl: cloudflareFetch });
assert.equal(assessed.result.criteria[0].score, 3);
assert.equal(assessed.result.remarks.length, 1, 'remarks without an exact source quote must be rejected');

const feedbackFetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  assert.equal(request.response_format.type, 'json_schema');
  assert.deepEqual(request.response_format.json_schema.required, ['assessment', 'improvements', 'next']);
  assert.match(request.prompt, /Do not change, recalculate or question any score/);
  assert.match(request.prompt, /Translate every learner-facing prose passage/);
  assert.match(request.prompt, /concrete corrected wording character-for-character/);
  assert.match(request.prompt, /use linking words/);
  const result = {
    assessment: 'Your main idea is clear and the approved score is preserved.',
    improvements: 'Use more linking words, such as moreover, thus and nevertheless, to connect ideas.',
    next: 'Add one suitable linking expression when moving between each main point.'
  };
  return new Response(JSON.stringify({ result: { response: JSON.stringify(result) } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const generatedFeedback = await runAI({
  action: 'feedback', provider: 'cloudflare',
  input: {
    text: 'Original mistak.', topic: 'Test', genre: 'opinion', level: 'B1', task: 'Write an opinion.', feedbackLanguage: 'en',
    score: 3, max: 4, criteria: [{ name: 'Accuracy', score: 3, max: 4, comment: 'use linking words' }],
    remarks: [], strengths: 'Clear idea.', priorities: 'use linking words', next: 'revise links'
  },
  env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }, fetchImpl: feedbackFetch
});
assert.match(generatedFeedback.result.improvements, /moreover/);
assert.equal(generatedFeedback.result.assessment.includes('3 / 4'), false, 'AI body must not restate or alter the fixed score header');

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

console.log('PASS: provider selection, image validation, Gemini recognition, Cloudflare assessment, expanded feedback and explicit license handling');
