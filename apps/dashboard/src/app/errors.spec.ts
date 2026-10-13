import { HttpErrorResponse } from '@angular/common/http';
import { describeError } from './errors';

const failure = (status: number, message?: string) => new HttpErrorResponse({ status, error: message ? { message } : null });
const say = (error: unknown) => describeError(error, 'http://127.0.0.1:3000', 'http://localhost:4200');

describe('describeError', () => {
  it('says what to check when the API cannot be reached at all (status 0: not running, or CORS)', () => {
    const text = say(failure(0));
    expect(text).toContain('http://127.0.0.1:3000');
    expect(text).toContain('CORS_ORIGINS');
    expect(text).toContain('http://localhost:4200');
  });

  it('explains a refused token and how to make a new one', () => {
    expect(say(failure(401))).toContain('token-cli.ts');
  });

  it('passes on the API’s own reason for a bad request', () => {
    expect(say(failure(400, 'limit must be at most 1000'))).toContain('limit must be at most 1000');
  });

  it('does not tell a device of another tenant from one that does not exist', () => {
    expect(say(failure(404))).toBe('No such device (or it belongs to another tenant).');
  });

  it('has a sentence for server errors and for anything else', () => {
    expect(say(failure(500))).toContain('500');
    expect(say(new Error('boom'))).toBe('Something unexpected went wrong.');
  });
});
