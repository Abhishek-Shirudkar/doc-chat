// Document chunking and BM25 ranking. No dependencies.

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'you', 'i', 'my', 'me', 'to', 'for', 'of', 'and', 'or', 'it', 'in', 'on', 'at', 'can', 'what', 'how', 'with', 'any', 'this', 'that', 'be', 'by', 'as', 'from', 'about', 'which', 'who', 'when', 'where', 'there', 'their', 'they']);

export const tokenize = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));

const PAGE_MARK = /\[\[page (\d+)\]\]/g;

// Split text into overlapping chunks. The client marks PDF pages as "[[page N]]";
// text is split at those markers first so a chunk never spans two pages and its
// page label is always right.
export function chunkText(text, size = 700, overlap = 120) {
  const clean = text.replace(/\r\n/g, '\n');

  const segments = [];
  let page = null;
  let last = 0;
  for (const m of clean.matchAll(PAGE_MARK)) {
    segments.push({ page, body: clean.slice(last, m.index) });
    page = Number(m[1]);
    last = m.index + m[0].length;
  }
  segments.push({ page, body: clean.slice(last) });

  const chunks = [];
  for (const seg of segments) {
    const body = seg.body;
    let start = 0;
    while (start < body.length) {
      let end = Math.min(start + size, body.length);
      if (end < body.length) {
        // Prefer to break at a paragraph or sentence boundary near the end.
        const offset = Math.floor(size * 0.6);
        const window = body.slice(start + offset, end);
        const para = window.lastIndexOf('\n\n');
        const sent = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
        const cut = para !== -1 ? para : sent;
        if (cut !== -1) end = start + offset + cut + 1;
      }
      const piece = body.slice(start, end).trim();
      if (piece.length > 20) chunks.push({ id: chunks.length + 1, text: piece, page: seg.page });
      if (end >= body.length) break;
      start = Math.max(end - overlap, start + 1);
    }
  }
  return chunks;
}

// BM25 ranking of chunks against a query. Returns the top `k` chunks with score > 0.
export function rank(chunks, query, k = 4) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !chunks.length) return [];

  const docs = chunks.map((c) => tokenize(c.text));
  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);

  const k1 = 1.5;
  const b = 0.75;
  return chunks
    .map((chunk, i) => {
      const tf = new Map();
      for (const t of docs[i]) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const t of terms) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * docs[i].length) / avgLen));
      }
      return { chunk, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k)
    .map((r) => r.chunk);
}
