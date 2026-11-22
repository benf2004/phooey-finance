const buildPrefix = import.meta.env.BASE_URL.replace(/\/$/, "");
const legacyPrefix = location.pathname.startsWith('/invoicer/') ? '/invoicer' : '';
const sharedPrefix = location.pathname.match(/^\/w\/[a-z][a-z0-9-]{0,23}(?=\/s\/)/)?.[0] || '';
const prefix = buildPrefix || legacyPrefix;
export const invoicePath = (path: string) => (path.startsWith('/s/') ? sharedPrefix || prefix : prefix) + path;
export const currentPath = () => location.pathname.slice((sharedPrefix || prefix).length) || "/";
export const bundled = import.meta.env.VITE_HOSTED === 'true' || prefix === '/invoicer';
