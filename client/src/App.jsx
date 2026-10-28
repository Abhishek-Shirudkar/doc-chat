import { useEffect, useRef, useState } from 'react';
import { streamChat } from './chat.js';
import { readFile } from './readFile.js';
import { SAMPLE_NAME, SAMPLE_TEXT } from './sample.js';

const MAX_CHARS = 60000;

// Turns "[1]" markers in an answer into small badges.
function Answer({ text }) {
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((p, i) => (/^\[\d+\]$/.test(p) ? <sup key={i} className="cite">{p.slice(1, -1)}</sup> : p));
}

export default function App() {
  const [doc, setDoc] = useState(null); // { name, text }
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState([]); // { role, content, sources? }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const endRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  async function loadFile(file) {
    if (!file) return;
    setError('');
    setLoading(true);
    try {
      const text = (await readFile(file)).trim();
      if (text.length < 20) throw new Error('No readable text found. Scanned PDFs need OCR, which this demo does not include.');
      if (text.length > MAX_CHARS) throw new Error(`That document is too long for this demo (limit ${MAX_CHARS.toLocaleString('en-US')} characters).`);
      setDoc({ name: file.name, text });
      setMessages([]);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function loadSample() {
    setError('');
    setDoc({ name: SAMPLE_NAME, text: SAMPLE_TEXT });
    setMessages([]);
  }

  async function send(text) {
    const question = text.trim();
    if (!question || busy || !doc) return;
    setError('');
    setInput('');
    setBusy(true);

    const history = [...messages, { role: 'user', content: question }];
    const payload = history.slice(-8).map(({ role, content }) => ({ role, content }));
    setMessages([...history, { role: 'assistant', content: '', sources: [] }]);

    const patchLast = (fn) =>
      setMessages((prev) => {
        const copy = prev.slice();
        copy[copy.length - 1] = fn(copy[copy.length - 1]);
        return copy;
      });

    try {
      await streamChat(doc.text, payload, {
        onSources: (sources) => patchLast((m) => ({ ...m, sources })),
        onDelta: (delta) => patchLast((m) => ({ ...m, content: m.content + delta })),
      });
    } catch (e) {
      setError(e.message);
      setMessages((prev) => prev.filter((m, i) => !(i === prev.length - 1 && m.role === 'assistant' && !m.content)));
    } finally {
      setBusy(false);
    }
  }

  const suggestions = doc?.name === SAMPLE_NAME
    ? ['How big is the home office stipend?', 'Can I work from another country?', 'What if my laptop is stolen?']
    : [];

  return (
    <div className="shell">
      <header>
        <h1>DocChat</h1>
        <p>Upload a document and ask questions. Every answer cites the passages it came from.</p>
      </header>

      <section
        className={`drop ${dragging ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          loadFile(e.dataTransfer.files?.[0]);
        }}
      >
        {doc ? (
          <div className="docbar">
            <div>
              <strong>{doc.name}</strong>
              <span className="muted"> · {doc.text.length.toLocaleString('en-US')} characters</span>
            </div>
            <button className="link" onClick={() => fileRef.current?.click()}>Replace</button>
          </div>
        ) : (
          <div className="empty-drop">
            <p>{loading ? 'Reading document…' : 'Drop a PDF, .txt or .md file here'}</p>
            <div className="row">
              <button onClick={() => fileRef.current?.click()} disabled={loading}>Choose file</button>
              <button className="secondary" onClick={loadSample} disabled={loading}>Try a sample document</button>
            </div>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.txt,.md,.markdown,text/plain,application/pdf"
          hidden
          onChange={(e) => {
            loadFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </section>

      <main className="chat" aria-live="polite">
        {messages.length === 0 && (
          <div className="hint">
            {doc ? <p>Ask anything about the document.</p> : <p>Add a document above to get started.</p>}
            <div className="chips">
              {suggestions.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">
              {m.role === 'assistant' ? (
                m.content ? <Answer text={m.content} /> : busy && i === messages.length - 1 ? <span className="muted">Searching the document…</span> : null
              ) : (
                m.content
              )}
            </div>
            {m.role === 'assistant' && m.sources?.length > 0 && (
              <details className="sources">
                <summary>{m.sources.length} passage{m.sources.length > 1 ? 's' : ''} used</summary>
                {m.sources.map((s) => (
                  <blockquote key={s.n}>
                    <span className="cite">{s.n}</span>
                    {s.page ? <span className="muted"> page {s.page}</span> : null}
                    <p>{s.text}</p>
                  </blockquote>
                ))}
              </details>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </main>

      {error && <div className="error" role="alert">{error}</div>}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={doc ? 'Ask about the document…' : 'Add a document first'}
          maxLength={600}
          disabled={!doc}
          aria-label="Your question"
        />
        <button type="submit" disabled={busy || !doc || !input.trim()}>Ask</button>
      </form>
    </div>
  );
}
