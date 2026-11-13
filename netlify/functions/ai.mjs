import { availableProviders, runAI } from './lib/ai-providers.mjs';

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
};

function reply(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}
export async function handler(event) {
  const allowedOrigins = (process.env.AI_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const origin = event.headers?.origin || event.headers?.Origin || '';
  if (allowedOrigins.length && (!origin || !allowedOrigins.includes(origin))) return reply(403, { ok: false, error: 'Источник запроса не разрешён.' });
  if (event.httpMethod === 'GET') return reply(200, { ok: true, providers: availableProviders(), defaultProvider: process.env.AI_PROVIDER || 'auto' });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Метод не поддерживается.' });
  try {
    if (Buffer.byteLength(event.body || '', 'utf8') > 6 * 1024 * 1024) return reply(413, { ok: false, error: 'Запрос слишком большой.' });
    const body = JSON.parse(event.body || '{}');
    const output = await runAI(body);
    return reply(200, { ok: true, ...output });
  } catch (error) {
    console.error('CriteriaLab AI error:', error?.message || error);
    const configurationError = /не задан|не настроен/i.test(error?.message || '');
    return reply(configurationError ? 503 : 400, { ok: false, error: error?.message || 'Не удалось выполнить AI-запрос.' });
  }
}
