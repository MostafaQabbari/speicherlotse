export function codeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}