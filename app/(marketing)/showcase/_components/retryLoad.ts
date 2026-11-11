import { isNetworkFailureError } from '@/lib/supabaseErrors';

/** Three's file loaders expose HTTP responses; image loaders only give an error event. */
function transient(error: unknown): boolean {
  if (isNetworkFailureError(error)) return true;
  if (typeof Event !== 'undefined' && error instanceof Event) return error.type === 'error';
  if (!error || typeof error !== 'object') return false;
  const response = 'response' in error ? error.response as Response | undefined : undefined;
  const status = response?.status ?? (error instanceof Error
    ? Number(error.message.match(/responded with (\d{3}):/)?.[1])
    : 0);
  return status === 429 || (status >= 500 && status <= 599);
}

/** Retry temporary Storage failures twice, with backoff; missing files and decode errors fail immediately. */
export async function retryLoad<T>(load: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await load();
    } catch (error) {
      if (attempt === 2 || !transient(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}
