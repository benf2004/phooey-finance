import { invoicePath } from './paths';
import { useEffect, useState } from 'react';
import { Download, FileText, LockKeyhole, Printer } from 'lucide-react';
import PdfViewer from './pdf-viewer';
import { money } from '../shared/model';
interface Info { number: string; title: string; businessName: string; status: string; currency: string; locale: string; total: number; balanceDue: number }
export default function SharedInvoice({ token }: { token: string }) {
  const [info, setInfo] = useState<Info>(); const [error, setError] = useState('');
  const path = invoicePath(`/s/${encodeURIComponent(token)}`);
  useEffect(() => { let active = true; fetch(`${path}/info`).then(async res => { if (!res.ok) throw new Error('This invoice link is unavailable. Ask the sender for a new link.'); const data: Info = await res.json(); if (active) { setInfo(data); document.title = `${data.title} ${data.number} — ${data.businessName}`; } }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [path]);
  return <div className="shared-invoice">{error ? <div className="panel shared-unavailable"><LockKeyhole size={26} /><h1>Invoice unavailable</h1><p>{error}</p></div> : !info ? <div className="loading-state">Opening invoice…</div> : <><header className="shared-header"><span className="brand-mark"><FileText size={20} /></span><div><h1>{info.businessName}</h1><p>{info.title} {info.number} <span className={`badge ${info.status}`}>{info.status}</span></p></div><div className="shared-balance"><span>Balance due</span><strong>{money(info.balanceDue, info.currency, info.locale)}</strong></div><a className="button primary" href={`${path}/pdf`} download={`${info.number}.pdf`}><Download size={16} /> Download PDF</a><button className="button" onClick={() => window.print()}><Printer size={16} /> Print</button></header><main className="shared-content"><PdfViewer url={`${path}/pdf`} /></main><footer><LockKeyhole size={12} /> Shared privately by {info.businessName}</footer></>}</div>;
}
