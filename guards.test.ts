import { describe, expect, it } from 'vitest';
import { isSecretKey } from '../../build/guards';

const jwt = (role: string) => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.sig`;
describe('isSecretKey', () => {
  it('rejects real-shaped secret keys', () => {
    expect(isSecretKey(jwt('service_role'))).toBe(true);     // legacy key: the word is hidden inside base64, so a text search would miss it
    expect(isSecretKey('sb_secret_abc123')).toBe(true);
  });
  it('accepts anon and publishable keys', () => {
    expect(isSecretKey(jwt('anon'))).toBe(false);
    expect(isSecretKey('sb_publishable_abc123')).toBe(false);
  });
});
