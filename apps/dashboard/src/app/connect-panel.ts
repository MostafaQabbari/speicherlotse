import { Component, inject } from '@angular/core';
import { AbstractControl, FormControl, FormGroup, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { DashboardStore } from './dashboard-store';
import { DEFAULT_API_URL, Session } from './session';

/** A token is three parts separated by dots (header.payload.signature). The API decides whether it is valid. */
export function tokenShape(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  return value === '' || /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value) ? null : { tokenShape: true };
}

export function httpUrl(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (value === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? null : { httpUrl: true };
  } catch {
    return { httpUrl: true };
  }
}

@Component({
  selector: 'app-connect-panel',
  imports: [ReactiveFormsModule],
  template: `
    <section aria-labelledby="connect-heading" class="card">
      <h2 id="connect-heading">Connection</h2>
      <form [formGroup]="form" (ngSubmit)="connect()" novalidate>
        <div class="field">
          <label for="api-url">API address</label>
          <input
            id="api-url"
            type="url"
            formControlName="apiUrl"
            autocomplete="off"
            spellcheck="false"
            [attr.aria-invalid]="show('apiUrl')"
            aria-describedby="api-url-problem"
          />
          <p id="api-url-problem" class="problem" aria-live="polite">
            @if (show('apiUrl')) {
              Enter an address that starts with http:// or https://
            }
          </p>
        </div>
        <div class="field">
          <label for="token">Token</label>
          <input
            id="token"
            type="password"
            formControlName="token"
            autocomplete="off"
            spellcheck="false"
            [attr.aria-invalid]="show('token')"
            aria-describedby="token-help token-problem"
          />
          <p id="token-help" class="help">
            Create one with <code>node services/api/src/token-cli.ts alpha</code>. It is kept in this page's memory only and is forgotten when you close or reload the tab.
          </p>
          <p id="token-problem" class="problem" aria-live="polite">
            @if (show('token')) {
              @if (form.controls.token.hasError('required')) {
                Paste a token.
              } @else {
                That does not look like a token (three parts separated by dots).
              }
            }
          </p>
        </div>
        <div class="actions">
          <button type="submit" [disabled]="store.connecting()">{{ store.connecting() ? 'Connecting…' : 'Connect' }}</button>
          @if (session.signedIn()) {
            <button type="button" class="secondary" (click)="store.disconnect()">Disconnect</button>
          }
        </div>
      </form>
      @if (store.connectionMessage(); as message) {
        <p [class]="store.connectionFailed() ? 'error' : 'note'" [attr.role]="store.connectionFailed() ? 'alert' : 'status'">{{ message }}</p>
      }
    </section>
  `,
})
export class ConnectPanel {
  protected readonly store = inject(DashboardStore);
  protected readonly session = inject(Session);

  protected readonly form = new FormGroup({
    apiUrl: new FormControl(DEFAULT_API_URL, { nonNullable: true, validators: [Validators.required, httpUrl] }),
    token: new FormControl('', { nonNullable: true, validators: [Validators.required, tokenShape] }),
  });

  protected show(name: 'apiUrl' | 'token'): 'true' | null {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || control.dirty) ? 'true' : null;
  }

  protected async connect(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const { apiUrl, token } = this.form.getRawValue();
    await this.store.connect(apiUrl.trim().replace(/\/+$/, ''), token.trim());
  }
}
