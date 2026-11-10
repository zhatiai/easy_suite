/**
 * RFC4122 v4 UUID generator polyfill.
 * Uses crypto.getRandomValues (available across all contexts, including HTTP/LAN)
 * to ensure crypto.randomUUID functions properly even in non-SecureContext environments.
 */
const nativeRandomUUID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID.bind(crypto)
  : null;

export function generateUUID(): `${string}-${string}-${string}-${string}-${string}` {
  if (nativeRandomUUID) {
    return nativeRandomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
      (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)
    ) as `${string}-${string}-${string}-${string}-${string}`;
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  }) as `${string}-${string}-${string}-${string}-${string}`;
}

// Automatically patch global crypto.randomUUID if missing
if (typeof crypto !== 'undefined' && !nativeRandomUUID) {
  try {
    Object.defineProperty(crypto, 'randomUUID', {
      value: generateUUID,
      configurable: true,
      writable: true,
    });
  } catch {
    (crypto as unknown as { randomUUID: typeof generateUUID }).randomUUID = generateUUID;
  }
}
