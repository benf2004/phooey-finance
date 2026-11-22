import { invoicePath } from './paths';
let csrfToken = '';
let businessId = localStorage.getItem('invoicer-business') || 'default';
export function setBusiness(value: string) { businessId = value; localStorage.setItem('invoicer-business', value); }
export function assetPath(id: string) { return invoicePath(`/api/v1/assets/${id}?business=${encodeURIComponent(businessId)}`); }
export function businessHeaders() { return { 'X-Business-Id': businessId }; }
export function setCsrf(value: string) { csrfToken = value; }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("X-Business-Id", businessId);
  if (options.body && typeof options.body === 'string') headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD'].includes(options.method || 'GET')) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(invoicePath(path.startsWith('/auth') ? path : `/api/v1${path}`), { ...options, credentials: 'same-origin', headers });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: { message: 'Request failed' } })) as { error?: { message?: string; details?: Array<{ path: string; message: string }> } };
    const details = data.error?.details?.map((d: { path: string; message: string }) => `${d.path}: ${d.message}`).join('; ');
    if (response.status === 401 && !path.startsWith('/auth')) window.dispatchEvent(new Event('session-expired'));
    throw new Error(details || data.error?.message || `Request failed (${response.status})`);
  }
  return response.json();
}
export const body = (value: unknown) => JSON.stringify(value);
export async function allPages<T>(path: string): Promise<T[]> {
  let result: T[] = []; let page = 1;
  while (true) {
    const data = await api<{ items: T[]; total: number }>(`${path}?limit=100&page=${page}`);
    result = [...result, ...data.items]; if (result.length >= data.total) return result; page++;
  }
}
export function downloadBytes(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: 'application/pdf' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function prepareLogo(file: File): Promise<Blob> {
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Choose a PNG or JPEG logo');
  if (file.size > 10000000) throw new Error('Choose an image smaller than 10 MB');
  const image = await createImageBitmap(file);
  try {
    let scale = Math.min(1, 1000 / image.width, 1000 / image.height);
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, file.type, .85));
      if (blob && blob.size <= 262144) return blob; scale *= .65;
    }
    throw new Error('This image could not be resized below 256 KiB');
  } finally { image.close(); }
}
