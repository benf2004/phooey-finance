import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfViewer({ url, data }: { url?: string; data?: Uint8Array }) {
  const host = useRef<HTMLDivElement>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true; const root = host.current!; root.replaceChildren(); setError(''); setLoading(true);
    const task = getDocument(data ? { data: Uint8Array.from(data), enableXfa: false } : { url, enableXfa: false });
    const render = async () => {
      const pdf = await task.promise;
      for (let i = 1; i <= pdf.numPages && active; i++) {
        const page = await pdf.getPage(i); const natural = page.getViewport({ scale: 1 });
        const available = Math.max(250, root.clientWidth - 32); const ratio = Math.min(1.5, window.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale: Math.min(1.2, available / natural.width) * ratio });
        if (!active) return;
        const section = document.createElement('section'); section.className = 'pdf-page'; section.setAttribute('aria-label', `Invoice page ${i} of ${pdf.numPages}`);
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); canvas.setAttribute('aria-hidden', 'true');
        section.appendChild(canvas); root.appendChild(section);
        await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
        const content = await page.getTextContent();
        const text = document.createElement('p'); text.className = 'sr-only'; text.textContent = content.items.map(item => 'str' in item ? item.str : '').join(' '); section.appendChild(text);
        if (active) setLoading(false);
        page.cleanup();
      }
    };
    void render().catch(e => { if (active) { setError(e.message || 'The invoice PDF could not be displayed'); setLoading(false); } });
    return () => { active = false; void task.destroy(); root.replaceChildren(); };
  }, [url, data]);
  return <div className="pdf-viewer-container">{loading && <div className="loading-state">Rendering invoice pages…</div>}{error && <div className="inline-error" role="alert">{error}</div>}<div className="pdf-pages" ref={host} /></div>;
}
