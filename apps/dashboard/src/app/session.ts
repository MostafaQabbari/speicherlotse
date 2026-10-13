import { computed, inject, Injectable, signal } from '@angular/core';
import { Api } from './api/api';

export const DEFAULT_API_URL = 'http://127.0.0.1:3000';

/**
 * Where the API is and which token is used.
 * The token lives in memory only: it is never written to localStorage, a cookie or the URL,
 * so closing or reloading the tab forgets it.
 */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  readonly apiUrl = signal(DEFAULT_API_URL);
  readonly token = signal('');
  readonly signedIn = computed(() => this.token() !== '');

  signIn(apiUrl: string, token: string): void {
    this.apiUrl.set(apiUrl);
    this.token.set(token);
    this.api.rootUrl = apiUrl;
  }

  signOut(): void {
    this.token.set('');
  }
}
