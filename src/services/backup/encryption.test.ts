import { describe, it, expect } from 'vitest';
import {
  encryptBackup,
  decryptBackup,
  isEncryptedBackup,
  ENCRYPTED_BACKUP_FORMAT,
  ENCRYPTED_BACKUP_VERSION,
  DEFAULT_PBKDF2_ITERATIONS
} from './encryption';
import { createBackupArchive, parseBackupArchive, validateBackupArchive } from './backup';

const FAST_ITERATIONS = 1_000;

const SAMPLE_JSON = createBackupArchive({
  foods: [{
    id: 'f1', canonical_name: 'Chicken Breast', normalized_name: 'chickenbreast',
    calories_per_100g: 165, protein_per_100g: 31, carbs_per_100g: 0, fat_per_100g: 3.6,
    water_per_100g: 65, nutrition_basis: 'per_100g', source_type: 'user_entered',
    source_reference: null, confidence: 1, created_at: '2026-08-19T00:00:00.000Z', updated_at: '2026-08-19T00:00:00.000Z'
  }],
  food_logs: [{
    id: 'l1', date: '2026-08-19', food_id: 'f1', observation_id: null,
    amount_g: 250, amount_ml: null, calories: 412.5, protein_g: 77.5, carbs_g: 0, fat_g: 9,
    water_ml: 162.5, note: null, created_at: '2026-08-19T00:00:00.000Z'
  }]
});

function envelopeOf(payload: string): Record<string, unknown> {
  return JSON.parse(payload) as Record<string, unknown>;
}

describe('encryptBackup', () => {
  it('produces a JSON envelope with the documented fields', async () => {
    const payload = await encryptBackup(SAMPLE_JSON, 'hunter2', FAST_ITERATIONS);
    const envelope = envelopeOf(payload);

    expect(envelope.format).toBe(ENCRYPTED_BACKUP_FORMAT);
    expect(envelope.version).toBe(ENCRYPTED_BACKUP_VERSION);
    expect(envelope.kdf).toBe('PBKDF2-SHA256');
    expect(envelope.iterations).toBe(FAST_ITERATIONS);
    expect(typeof envelope.salt).toBe('string');
    expect(envelope.salt).toHaveLength(24); // 16 bytes -> base64
    expect(typeof envelope.iv).toBe('string');
    expect(envelope.iv).toHaveLength(16); // 12 bytes -> base64
    expect(typeof envelope.ciphertext).toBe('string');
    expect((envelope.ciphertext as string).length).toBeGreaterThan(16);
  });

  it('does not leak the archive JSON inside the envelope', async () => {
    const payload = await encryptBackup(SAMPLE_JSON, 'hunter2', FAST_ITERATIONS);
    expect(payload).not.toContain('Chicken Breast');
    expect(payload).not.toContain('food_logs');
  });

  it('uses a fresh random salt/IV: two runs produce different ciphertext', async () => {
    const a = await encryptBackup(SAMPLE_JSON, 'hunter2', FAST_ITERATIONS);
    const b = await encryptBackup(SAMPLE_JSON, 'hunter2', FAST_ITERATIONS);
    expect(a).not.toBe(b);
    expect(envelopeOf(a).ciphertext).not.toBe(envelopeOf(b).ciphertext);
  });

  it('rejects an empty password', async () => {
    await expect(encryptBackup(SAMPLE_JSON, '', FAST_ITERATIONS)).rejects.toThrow();
    await expect(encryptBackup(SAMPLE_JSON, '   ', FAST_ITERATIONS)).rejects.toThrow();
  });

  it('uses the default iteration count when none is given', async () => {
    const payload = await encryptBackup(SAMPLE_JSON, 'hunter2');
    expect(envelopeOf(payload).iterations).toBe(DEFAULT_PBKDF2_ITERATIONS);
  });
});

describe('decryptBackup', () => {
  it('round-trips the archive JSON byte-for-byte', async () => {
    const payload = await encryptBackup(SAMPLE_JSON, 'hunter2', FAST_ITERATIONS);
    const decrypted = await decryptBackup(payload, 'hunter2');
    expect(decrypted).toBe(SAMPLE_JSON);
  });

  it('round-trips through the real default KDF cost', async () => {
    const payload = await encryptBackup(SAMPLE_JSON, 'hunter2');
    const decrypted = await decryptBackup(payload, 'hunter2');
    expect(decrypted).toBe(SAMPLE_JSON);
  });

  it('decrypted output is a valid EverydayFuel archive', async () => {
    const payload = await encryptBackup(SAMPLE_JSON, 'hunter2', FAST_ITERATIONS);
    const decrypted = await decryptBackup(payload, 'hunter2');
    expect(parseBackupArchive(decrypted!)).not.toBeNull();
    expect(validateBackupArchive(parseBackupArchive(decrypted!))).toEqual([]);
  });

  it('returns null for a wrong password', async () => {
    const payload = await encryptBackup(SAMPLE_JSON, 'hunter2', FAST_ITERATIONS);
    expect(await decryptBackup(payload, 'wrong-password')).toBeNull();
  });

  it('returns null when any envelope field is missing', async () => {
    const payload = JSON.parse(await encryptBackup(SAMPLE_JSON, 'hunter2', FAST_ITERATIONS));
    for (const field of ['salt', 'iv', 'ciphertext', 'iterations', 'format']) {
      const broken = { ...payload };
      delete broken[field];
      expect(await decryptBackup(JSON.stringify(broken), 'hunter2')).toBeNull();
    }
  });

  it('returns null for plain (non-envelope) JSON', async () => {
    expect(await decryptBackup(SAMPLE_JSON, 'hunter2')).toBeNull();
    expect(await decryptBackup('not json {{{', 'hunter2')).toBeNull();
    expect(await decryptBackup('', 'hunter2')).toBeNull();
  });

  it('returns null for a tampered ciphertext (AES-GCM authentication)', async () => {
    const envelope = envelopeOf(await encryptBackup(SAMPLE_JSON, 'hunter2', FAST_ITERATIONS));
    const tampered = {
      ...envelope,
      ciphertext: 'A'.repeat((envelope.ciphertext as string).length)
    };
    expect(await decryptBackup(JSON.stringify(tampered), 'hunter2')).toBeNull();
  });

  it('returns null for a tampered salt', async () => {
    const envelope = envelopeOf(await encryptBackup(SAMPLE_JSON, 'hunter2', FAST_ITERATIONS));
    const tampered = { ...envelope, salt: 'A'.repeat(24) };
    expect(await decryptBackup(JSON.stringify(tampered), 'hunter2')).toBeNull();
  });

  it('returns null for a payload from a different format', async () => {
    const envelope = envelopeOf(await encryptBackup(SAMPLE_JSON, 'hunter2', FAST_ITERATIONS));
    const other = { ...envelope, format: 'some-other-format' };
    expect(await decryptBackup(JSON.stringify(other), 'hunter2')).toBeNull();
  });
});

describe('isEncryptedBackup', () => {
  it('recognizes encrypted envelopes', async () => {
    const payload = await encryptBackup(SAMPLE_JSON, 'hunter2', FAST_ITERATIONS);
    expect(isEncryptedBackup(payload)).toBe(true);
  });

  it('returns false for plain archive JSON, garbage and empty text', () => {
    expect(isEncryptedBackup(SAMPLE_JSON)).toBe(false);
    expect(isEncryptedBackup('not json {{{')).toBe(false);
    expect(isEncryptedBackup('')).toBe(false);
  });

  it('returns false for a lookalike envelope with a wrong format', () => {
    expect(isEncryptedBackup('{"format":"other-format","version":1}')).toBe(false);
  });
});