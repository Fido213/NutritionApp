/**
 * Password-based encrypted backup format for EverydayFuel (spec §23).
 *
 * The plain JSON archive produced by createBackupArchive() is wrapped in an
 * encrypted envelope before it is written to disk:
 *
 *   PBKDF2-HMAC-SHA256(password, random salt) -> AES-256-GCM key
 *   AES-256-GCM(random IV) encrypts the archive JSON
 *
 * The envelope is a small JSON object carrying the base64-encoded salt, IV
 * and ciphertext plus the KDF parameters, so decrypting only needs the
 * password — no external state, fully portable, works offline.
 *
 * Uses the platform Web Crypto API (browser / Capacitor WebView / Node):
 * no new dependencies.
 */

export const ENCRYPTED_BACKUP_FORMAT = 'everydayfuel-encrypted-backup';
export const ENCRYPTED_BACKUP_VERSION = 1;
export const DEFAULT_PBKDF2_ITERATIONS = 200_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

export interface EncryptedBackupEnvelope {
  format: 'everydayfuel-encrypted-backup';
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a backup archive (the JSON text produced by createBackupArchive)
 * with a user-supplied password. Returns the serialized envelope JSON.
 *
 * Throws when the password is empty — an unguessable empty-password archive
 * is worse than no archive at all.
 */
export async function encryptBackup(
  jsonText: string,
  password: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<string> {
  if (!password.trim()) {
    throw new Error('Backup password must not be empty');
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(jsonText)
  );

  const envelope: EncryptedBackupEnvelope = {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: ENCRYPTED_BACKUP_VERSION,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };

  return JSON.stringify(envelope);
}

/**
 * Decrypt an encrypted backup envelope. Returns the original archive JSON
 * text, or null when the password is wrong, the payload is not an
 * EverydayFuel encrypted backup, or the data was tampered with
 * (AES-GCM authentication fails).
 */
export async function decryptBackup(
  payloadText: string,
  password: string
): Promise<string | null> {
  let envelope: EncryptedBackupEnvelope;
  try {
    envelope = JSON.parse(payloadText) as EncryptedBackupEnvelope;
    if (!envelope || typeof envelope !== 'object') return null;
    if (envelope.format !== ENCRYPTED_BACKUP_FORMAT) return null;
    if (envelope.version !== ENCRYPTED_BACKUP_VERSION) return null;
    if (envelope.kdf !== 'PBKDF2-SHA256') return null;
    if (!envelope.salt || !envelope.iv || !envelope.ciphertext) return null;
  } catch {
    return null;
  }

  const iterations =
    typeof envelope.iterations === 'number' && envelope.iterations > 0
      ? envelope.iterations
      : DEFAULT_PBKDF2_ITERATIONS;

  try {
    const key = await deriveKey(password, base64ToBytes(envelope.salt), iterations);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.ciphertext)
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/**
 * Cheap sniff: does this text look like an EverydayFuel encrypted backup
 * envelope? Plain JSON archives return false (they stay fully restorable
 * without a password).
 */
export function isEncryptedBackup(payloadText: string): boolean {
  try {
    const parsed = JSON.parse(payloadText);
    return !!(
      parsed &&
      typeof parsed === 'object' &&
      (parsed as Record<string, unknown>).format === ENCRYPTED_BACKUP_FORMAT
    );
  } catch {
    return false;
  }
}