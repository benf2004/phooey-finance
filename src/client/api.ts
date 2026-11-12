import { useRef } from "react";
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api" + path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
export function post<T>(
  path: string,
  data: unknown,
  method = "POST",
  requestKey: string = crypto.randomUUID(),
) {
  return api<T>(path, {
    method,
    body: JSON.stringify(data),
    headers: { "Idempotency-Key": requestKey },
  });
}

// Preserve a submission identity when a committed response is lost.
export function useSubmit() {
  const last = useRef<{ body: string; key: string } | null>(null);
  return <T>(path: string, data: unknown, method = "POST") => {
    const body = JSON.stringify({ path, data, method });
    if (last.current?.body !== body)
      last.current = { body, key: crypto.randomUUID() };
    return post<T>(path, data, method, last.current.key);
  };
}
