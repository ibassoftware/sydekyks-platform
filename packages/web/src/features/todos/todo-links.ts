// A task link may be resumed after authentication without accepting an external redirect.
export function todoReturnPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const url = new URL(value, 'https://sydekyks.local');
    if (
      url.origin !== 'https://sydekyks.local' ||
      !/^\/todos\/[a-zA-Z0-9_-]+\/resolve$/.test(url.pathname)
    )
      return null;
    const search = new URLSearchParams();
    const status = url.searchParams.get('status');
    if (status !== null) search.set('status', status);
    return url.pathname + (search.size ? `?${search.toString()}` : '');
  } catch {
    return null;
  }
}
