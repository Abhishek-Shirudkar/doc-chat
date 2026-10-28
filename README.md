# DocChat: ask questions about your documents

Upload a PDF, text or Markdown file and chat with it. Answers stream in live and cite the exact passages (and PDF page numbers) they came from, so you can check them.

**Stack:** React 18 + Vite on the front end, plain Node.js (no framework) on the back end. The answers come from an LLM API: a free Groq key (Llama models) or an Anthropic Claude key, your choice.

## How it works

1. **Reading the file:** the browser extracts the text (PDFs with pdf.js, page by page). Nothing is stored on the server.
2. **Chunking:** the server splits the text into overlapping passages of about 700 characters. Chunks never cross a PDF page, so page numbers are accurate.
3. **Retrieval:** passages are ranked against the question with BM25 (a classic keyword-relevance formula). The previous question is included so follow-ups like "and for contractors?" still find the right passages.
4. **Answering:** the top 4 passages are sent to the model with strict instructions to answer only from them, cite them as [1], [2], and say "not found" otherwise.
5. **Streaming:** the reply is streamed to the browser as server-sent events, together with the passages used, which appear under each answer.

## Features

- PDF, .txt and .md upload (drag and drop or file picker) and a built-in sample document
- Streaming answers with numbered citations and an expandable "passages used" list
- Demo mode: with no API key the server returns the best-matching passages, so the app works with zero setup
- Input validation, document size limit, per-IP rate limit and a response length cap to keep a public demo cheap
- Light and dark mode, mobile friendly

## Run it locally

You need Node.js 18 or newer.

```bash
# 1. API (http://localhost:4200)
cd server
# optional: real AI answers with a free Groq key (see below)
# export GROQ_API_KEY=your-key           (Windows PowerShell: $env:GROQ_API_KEY="your-key")
npm start

# 2. Front end (http://localhost:5173), in a second terminal
cd client
npm install
npm run dev
```

The server has no dependencies, so it needs no `npm install`.

## Getting a free AI key (Groq)

1. Sign up at [console.groq.com](https://console.groq.com) (no credit card needed) and create a key under **API Keys**.
2. Set it as `GROQ_API_KEY` before starting the server. The log line should say `groq: llama-3.1-8b-instant`.

Free-tier limits and available models change, so check Groq's current limits page. If a model is retired, set `LLM_MODEL` to another one from their model list. Any OpenAI-compatible provider also works via `LLM_BASE_URL`.

## Configuration (server environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | none | Free option. Enables real answers via Groq |
| `ANTHROPIC_API_KEY` | none | Alternative: answers via Claude. Used only if no Groq key is set |
| `LLM_MODEL` | `llama-3.1-8b-instant` (Groq) or `claude-haiku-5-5` | Model used for replies |
| `LLM_BASE_URL` | provider default | Point at another OpenAI-compatible API |
| `ALLOWED_ORIGIN` | `*` | Set to your front-end URL in production |
| `RATE_LIMIT_PER_HOUR` | `30` | Questions per IP per hour |
| `PORT` | `4200` | Port to listen on |

With no key the server runs in demo mode and returns the best-matching passages.

## Deploying

1. **API (Render):** new Web Service from this repo, root directory `server`, start command `npm start`. Add `GROQ_API_KEY` and `ALLOWED_ORIGIN`.
2. **Front end (Vercel):** import the repo, root directory `client`, framework Vite, environment variable `VITE_API_URL` set to the Render URL (no trailing slash).

## Limits and next steps

- Documents are limited to 60,000 characters (roughly 25 pages) in this demo, and scanned PDFs need OCR, which is not included.
- Retrieval is keyword-based. For larger or more varied documents the next step is embeddings with a vector store (pgvector or similar), keeping the same chunking and citation flow.
- Other next steps: multiple documents, saved conversations, and sign-in.
