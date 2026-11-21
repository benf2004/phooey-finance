const prefix = import.meta.env.BASE_URL.replace(/\/$/, "");
export const invoicePath = (path: string) => prefix + path;
export const currentPath = () => location.pathname.slice(prefix.length) || "/";
export const bundled = prefix === "/invoicer";
