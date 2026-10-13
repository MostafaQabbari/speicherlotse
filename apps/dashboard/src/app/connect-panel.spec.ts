import { FormControl } from '@angular/forms';
import { httpUrl, tokenShape } from './connect-panel';

const check = (validator: (c: FormControl) => unknown, value: string) => validator(new FormControl(value));

describe('connect form checks', () => {
  it('accepts three parts separated by dots, with surrounding spaces', () => {
    expect(check(tokenShape, 'abc.def-1_2.ghi')).toBeNull();
    expect(check(tokenShape, '  abc.def.ghi \n')).toBeNull();
  });

  it.each(['abc', 'abc.def', 'a.b.c.d', 'a b.c.d', 'Bearer a.b.c'])('rejects %j as a token', (value) => {
    expect(check(tokenShape, value)).toEqual({ tokenShape: true });
  });

  it('accepts http and https addresses only', () => {
    expect(check(httpUrl, 'http://127.0.0.1:3000')).toBeNull();
    expect(check(httpUrl, 'https://api.example.org')).toBeNull();
    for (const bad of ['127.0.0.1:3000', 'ftp://x.org', 'javascript:alert(1)', 'not a url']) {
      expect(check(httpUrl, bad)).toEqual({ httpUrl: true });
    }
  });
});
