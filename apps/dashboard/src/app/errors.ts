import { HttpErrorResponse } from '@angular/common/http';

/** A sentence a person can act on, for whatever went wrong with a request. */
export function describeError(error: unknown, apiUrl: string, pageOrigin: string): string {
  if (!(error instanceof HttpErrorResponse)) return 'Something unexpected went wrong.';
  const detail = typeof error.error?.message === 'string' ? error.error.message : '';
  switch (error.status) {
    case 0:
      return `Cannot reach the API at ${apiUrl}. Is it running, and is ${pageOrigin} listed in its CORS_ORIGINS?`;
    case 400:
      return `The API did not accept the request: ${detail || 'bad parameters'}.`;
    case 401:
      return 'The API did not accept the token (wrong, expired, or signed with another secret). Create a new one with: node services/api/src/token-cli.ts alpha';
    case 404:
      return 'No such device (or it belongs to another tenant).';
    default:
      return `The API answered with an error (${error.status}).${detail ? ' ' + detail : ''}`;
  }
}
