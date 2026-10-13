import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Session } from './session';

/** Adds the token to requests for the API, and only to those: never to any other address. */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const session = inject(Session);
  const base = session.apiUrl();
  if (session.signedIn() && (request.url === base || request.url.startsWith(base + '/'))) {
    return next(request.clone({ setHeaders: { Authorization: `Bearer ${session.token()}` } }));
  }
  return next(request);
};
