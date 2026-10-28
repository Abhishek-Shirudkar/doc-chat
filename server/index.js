import http from 'node:http';
import { chunkText, rank } from './retrieval.js';

const PORT = process.env.PORT || 4200;
// Provider selection: a free Groq key (OpenAI-compatible API) or an Anthropic key.
// Overrides: LLM_MODEL, LLM_BASE_URL. With no key the server runs in demo mode.
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PROVIDER = GROQ_KEY ? 'groq' : ANTHROPIC_KEY ? 'anthropic' : 'demo';
const API_KEY = GROQ_KEY || ANTHROPIC_KEY;
const BASE_URL = (
  process.env.LLM_BASE_URL ||
  process.env.ANTHROPIC_BASE_URL ||
  (PROVIDER === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.anthropic.com')
).replace(/\/$/, '');
const MODEL =
  process.env.LLM_MODEL || process.env.CLAUDE_MODEL || (PROVIDER === 'groq' ? 'llama-3.1-8b-instant' : 'claude-haiku-5-5');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR || 30);

const MAX_DOC_CHARS = 60_000;
const MAX_MESSAGES = 10;
const MAX_QUESTION_CHARS = 600;
const BODY_LIMIT = 120_000;
const WHOLE_DOC_CHARS = 8000; // documents up to this size are sent to the model in full

const SYSTEM = `You answer questions about a document the user has uploaded.
You are given numbered excerpts from that document. Answer using only those excerpts.
After each claim, cite the excerpt it came from like [1] or [2]. If the excerpts do not contain the answer, say you could not find it in the document. Never use outside knowledge to fill gaps.
If the user greets you, reply briefly and say what the document appears to be about. If they ask for an overview, a summary or "what is this", summarise the excerpts.
Be concise: a short paragraph or a few bullet points.`;

// ---- tiny per-IP rate limiter (in memory) ----
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > BODY_LIMIT) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function validate(body) {
  let p;
  try {
    p = JSON.parse(body);
  } catch {
    return { error: 'Body must be valid JSON.' };
  }
  if (!p || typeof p.document !== 'string' || p.document.trim().length < 20) {
    return { error: 'Please add a document with some text first.' };
  }
  if (p.document.length > MAX_DOC_CHARS) {
    return { error: `Document is too long for this demo (limit ${MAX_DOC_CHARS.toLocaleString('en-US')} characters).` };
  }
  const msgs = p.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return { error: 'messages must be a non-empty array.' };
  if (msgs.length > MAX_MESSAGES) return { error: `At most ${MAX_MESSAGES} messages per request.` };
  for (const m of msgs) {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) {
      return { error: 'Each message needs a role (user or assistant) and non-empty text.' };
    }
    if (m.content.length > (m.role === 'user' ? MAX_QUESTION_CHARS : 4000)) {
      return { error: `Questions are limited to ${MAX_QUESTION_CHARS} characters.` };
    }
  }
  if (msgs[msgs.length - 1].role !== 'user') return { error: 'The last message must be from the user.' };
  return { document: p.document, messages: msgs.map((m) => ({ role: m.role, content: m.content.trim() })) };
}

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

const buildContext = (excerpts) =>
  excerpts.map((c, i) => `[${i + 1}]${c.page ? ` (page ${c.page})` : ''} ${c.text}`).join('\n\n');

// Reads a server-sent-event response and calls handle(eventDataString) for each "data:" line.
async function readSSE(upstream, handle) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (line) handle(line.slice(5).trim());
    }
  }
}

async function failIfBad(upstream) {
  if (upstream.ok && upstream.body) return;
  const detail = await upstream.text().catch(() => '');
  const err = new Error(`${PROVIDER} API ${upstream.status} ${detail.slice(0, 300)}`);
  err.status = upstream.status;
  throw err;
}

// Anthropic Messages API
async function streamAnthropic(messages, system, onText) {
  const upstream = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, stream: true, system, messages }),
  });
  await failIfBad(upstream);
  await readSSE(upstream, (data) => {
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') onText(evt.delta.text);
    if (evt.type === 'error') throw new Error(evt.error?.message || 'stream error');
  });
}

// OpenAI-compatible Chat Completions API (Groq and many others)
async function streamOpenAICompatible(messages, system, onText, model = MODEL) {
  const upstream = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      temperature: 0.2,
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  await failIfBad(upstream);
  await readSSE(upstream, (data) => {
    if (data === '[DONE]') return;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    if (evt.error) throw new Error(evt.error.message || 'stream error');
    const text = evt.choices?.[0]?.delta?.content;
    if (text) onText(text);
  });
}

// Free Groq accounts do not always have every model enabled, so if the chosen model
// returns 404 (not found / no access), try the next one. The first that works is remembered.
const GROQ_FALLBACKS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'];
let workingModel = null;

async function streamLLM(messages, excerpts, onText) {
  const system = `${SYSTEM}\n\nDocument excerpts:\n${buildContext(excerpts) || '(no relevant excerpts found)'}`;
  if (PROVIDER !== 'groq') return streamAnthropic(messages, system, onText);

  const candidates = [workingModel, MODEL, ...(process.env.LLM_MODEL ? [] : GROQ_FALLBACKS)].filter(
    (m, i, a) => m && a.indexOf(m) === i,
  );
  let lastErr;
  for (const model of candidates) {
    try {
      await streamOpenAICompatible(messages, system, onText, model);
      if (workingModel !== model) {
        workingModel = model;
        console.log(`Using Groq model: ${model}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      if (err.status !== 404) throw err; // only a missing model is worth retrying with another
      console.error(`Model ${model} not available (404), trying next`);
    }
  }
  throw lastErr;
}

// No API key: show the best-matching passages so the app still demonstrates retrieval.
async function demoReply(excerpts, onText) {
  const text = excerpts.length
    ? `(Demo mode, no AI key configured) The most relevant passages are: ${excerpts.slice(0, 2).map((c, i) => `[${i + 1}] ${c.text}`).join(' ')}`
    : '(Demo mode, no AI key configured) I could not find anything relevant to that in the document.';
  for (const word of text.split(' ')) {
    onText(word + ' ');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Turns a provider failure into a message that tells the user what to fix.
function friendlyError(err) {
  const s = err.status;
  if (s === 401 || s === 403) return `The AI provider rejected the API key (HTTP ${s}). Check that ${PROVIDER === 'groq' ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY'} is a valid key with no extra spaces or quotes, then restart the server.`;
  if (s === 404 || s === 400) return `The AI provider rejected the request (HTTP ${s}). The model "${MODEL}" may not be available; try setting LLM_MODEL to another model from the provider's list.`;
  if (s === 429) return 'The AI provider rate limit was reached. Wait a minute and try again.';
  if (s >= 500) return `The AI provider had a problem (HTTP ${s}). Please try again shortly.`;
  if (!s) return 'Could not reach the AI provider. Check the internet connection of the machine running the server.';
  return 'The assistant is unavailable right now. Please try again.';
}

// Decides which parts of the document the model sees.
// - Short documents (like a resume) are sent whole, so vague questions ("tell me about this") work.
// - Longer ones use BM25 retrieval; if nothing matches (greetings, "summarise this"), fall back to the opening.
function selectExcerpts(document, messages) {
  if (document.length <= WHOLE_DOC_CHARS) {
    const parts = chunkText(document, 1200, 0);
    return { chunks: parts, excerpts: parts };
  }
  const chunks = chunkText(document);
  // Rank on the new question plus the previous user turn so follow-ups still retrieve well.
  const users = messages.filter((m) => m.role === 'user');
  const query = users.slice(-2).map((m) => m.content).join(' ');
  const found = rank(chunks, query, 4);
  return { chunks, excerpts: found.length ? found : chunks.slice(0, 3) };
}

async function handleChat(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    return json(res, 413, { error: 'Request too large.' });
  }
  const v = validate(raw);
  if (v.error) return json(res, 400, { error: v.error });
  if (limited(ip)) return json(res, 429, { error: 'Rate limit reached for this demo. Please try again later.' });

  const { chunks, excerpts } = selectExcerpts(v.document, v.messages);

  cors(res);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  sse(res, {
    type: 'sources',
    sources: excerpts.map((c, i) => ({ n: i + 1, page: c.page, text: c.text })),
    chunks: chunks.length,
  });
  try {
    const onText = (text) => sse(res, { type: 'delta', text });
    if (PROVIDER !== 'demo') await streamLLM(v.messages, excerpts, onText);
    else {
      // Demo mode shows only the best-matching passages (not the whole document).
      const q = v.messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ');
      const best = rank(chunks, q, 2);
      await demoReply(best.length ? best : chunks.slice(0, 1), onText);
    }
    sse(res, { type: 'done' });
  } catch (err) {
    console.error(err.message, err.cause ? `(${err.cause.code || err.cause.message})` : '');
    sse(res, { type: 'error', message: friendlyError(err) });
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }
  const path = (req.url || '').split('?')[0];
  if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, mode: PROVIDER });
  if (req.method === 'POST' && path === '/api/chat') return handleChat(req, res);
  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`DocChat API on :${PORT} (${PROVIDER === 'demo' ? 'demo mode' : PROVIDER + ': ' + MODEL})`));
