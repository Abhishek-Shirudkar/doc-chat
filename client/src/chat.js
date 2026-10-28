// In development the Vite proxy forwards /api to localhost:4200.
// In production set VITE_API_URL to the hosted API, e.g. https://my-api.onrender.com
const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

// Sends the document and conversation; calls handlers as server-sent events arrive.
export async function streamChat(document, messages, { onSources, onDelta }) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document, messages }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!block.startsWith('data:')) continue;
      const evt = JSON.parse(block.slice(5).trim());
      if (evt.type === 'sources') onSources(evt.sources);
      else if (evt.type === 'delta') onDelta(evt.text);
      else if (evt.type === 'error') throw new Error(evt.message);
    }
  }
}
