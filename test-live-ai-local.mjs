// Local timing check of the real AI providers. Uses NO Netlify credits.
// Keys are read from your current PowerShell session only (never saved to files):
//   $env:GEMINI_API_KEY="..."; $env:CLOUDFLARE_ACCOUNT_ID="..."; $env:CLOUDFLARE_API_TOKEN="..."
//   node test-live-ai-local.mjs [path-to-photo.jpg]
process.env.AI_TOTAL_BUDGET_MS = '120000';
import fs from 'node:fs';
const { runAI } = await import('./netlify/functions/lib/ai-providers.mjs');
const env = { ...process.env, GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.6-flash' };
const photo = process.argv[2] || 'tmp/handwriting-sample.jpg';
if (!fs.existsSync(photo)) { console.error('Photo not found: ' + photo + '. Run without a path to use tmp/handwriting-sample.jpg, or pass the real path of a student photo.'); process.exit(1); }
const imageDataUrl = 'data:image/' + (photo.toLowerCase().endsWith('.png') ? 'png' : 'jpeg') + ';base64,' + fs.readFileSync(photo).toString('base64');
console.log('Photo:', photo, (fs.statSync(photo).size / 1024).toFixed(0) + ' KB');
const essay = Array(14).fill('In my opinion, university elections are important because they give students a voice in campus life. First, elections helps students choose leaders who understand their concerns.').join(' ');
const criteria = ['Task fulfilment', 'Development of arguments', 'Organisation', 'Vocabulary and style', 'Grammar'].map(name => ({ name, max: 4, descriptors: ['4: excellent', '2: partly', '0: not met'] }));
const t0 = () => Date.now();
for (const provider of ['cloudflare', 'gemini']) {
  if (provider === 'gemini' ? !env.GEMINI_API_KEY : !(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)) { console.log(provider, 'SKIPPED (no keys in this session)'); continue; }
  for (const [label, req] of [['recognize', { action: 'recognize', imageDataUrl }], ['assess', { action: 'assess', input: { text: essay, topic: 'University elections', criteria } }]]) {
    const start = t0();
    try { const r = await runAI({ ...req, provider, env }); console.log(provider, label, 'OK', ((Date.now() - start) / 1000).toFixed(1) + 's', JSON.stringify(r.result).slice(0, 90)); }
    catch (e) { console.log(provider, label, 'FAIL', ((Date.now() - start) / 1000).toFixed(1) + 's', e.message.slice(0, 200)); }
  }
}
