/**
 * CORS_ORIGINS: the web pages that may call this API from a browser, as a comma-separated list of origins,
 * for example `http://localhost:4200`. An origin is scheme, host and optional port, with no path and no trailing slash.
 * There is no wildcard: a browser page you did not name cannot read the answers. Empty or unset: no page may.
 */
export function parseOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const origins: string[] = [];
  for (const part of raw.split(',')) {
    const text = part.trim();
    if (text === '') throw new Error('CORS_ORIGINS has an empty entry; write origins separated by single commas');
    if (text.includes('*')) throw new Error('CORS_ORIGINS must name each origin; a wildcard "*" (everybody) is not allowed');
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error(`CORS_ORIGINS entry ${JSON.stringify(text)} is not an origin; write it like http://localhost:4200`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`CORS_ORIGINS entry ${JSON.stringify(text)} must start with http:// or https://`);
    }
    if (url.origin !== text) {
      throw new Error(`CORS_ORIGINS entry ${JSON.stringify(text)} must be exactly ${JSON.stringify(url.origin)} (no path, no trailing slash, host in lower case)`);
    }
    if (!origins.includes(text)) origins.push(text);
  }
  return origins;
}
