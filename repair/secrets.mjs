/**
 * Throws when any secret value appears anywhere in the serialised object.
 * Values shorter than 8 chars are ignored (cookie flags like "1" would false-positive).
 */
export function assertNoSecrets(obj, secrets) {
  const text = JSON.stringify(obj);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 8 && text.includes(s)) {
      throw new Error('document would leak a secret value; refusing to emit it');
    }
  }
}
