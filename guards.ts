/** True if a key is a Supabase SECRET key that must never be bundled into a browser app (legacy JWT service_role or new sb_secret_ keys). */
export function isSecretKey(key: string): boolean {
  const k = key.trim();
  if (k.startsWith('sb_secret_')) return true;
  const parts = k.split('.');
  if (parts.length === 3) {
    try { if (JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'service_role') return true; } catch { /* not a JWT */ }
  }
  return /service_role/i.test(k);
}
