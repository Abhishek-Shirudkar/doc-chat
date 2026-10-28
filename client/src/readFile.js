// Turns an uploaded file into plain text in the browser (nothing is stored on the server).
// PDF pages are marked "[[page N]]" so answers can cite page numbers.

async function readPdf(file) {
  // Loaded on demand so the PDF library is only downloaded when a PDF is chosen.
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  let out = '';
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const text = content.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
    out += `\n[[page ${n}]]\n${text}\n`;
  }
  return out.trim();
}

export async function readFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return readPdf(file);
  if (/\.(txt|md|markdown|csv)$/.test(name) || file.type.startsWith('text/')) return file.text();
  throw new Error('Please choose a PDF, .txt or .md file.');
}
