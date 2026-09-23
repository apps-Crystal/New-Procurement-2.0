/**
 * Application-layer encryption for vendor bank account numbers.
 *
 * The schema declares `vendor_bank_accounts.account_number_enc bytea` with the
 * comment "encrypted at application layer". That mattered when the store was a
 * database; it matters considerably more now that the store is a spreadsheet
 * anyone with the link could be granted sight of. `account_last4` is kept in
 * clear so staff can recognise an account without it being usable.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than returning plausible rubbish. A fresh 12-byte IV per encryption, stored
 * alongside the ciphertext. A cell cannot hold bytes, so the payload is base64.
 *
 * Stored form:  v1.<iv>.<ciphertext>.<authTag>   (each base64url)
 *
 * The version prefix is there so the format can change without guessing at
 * what old rows mean.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '@/lib/errors';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

function key(): Buffer {
  const raw = process.env.BANK_ENC_KEY;
  if (!raw) {
    throw new AppError(
      'INTERNAL',
      'Bank details cannot be stored because the encryption key is not configured.',
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new AppError(
      'INTERNAL',
      `BANK_ENC_KEY must decode to ${KEY_BYTES} bytes; it decoded to ${buf.length}. Generate one with: openssl rand -base64 32`,
    );
  }
  return buf;
}

/** True when encryption is configured — lets a screen hide bank entry rather than fail on save. */
export function encryptionConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, b64(iv), b64(encrypted), b64(tag)].join('.');
}

export function decryptSecret(stored: string): string {
  const parts = (stored ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new AppError('INTERNAL', 'That stored bank account number is not in a format this system can read.');
  }
  const [, ivPart, dataPart, tagPart] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, key(), unb64(ivPart));
    decipher.setAuthTag(unb64(tagPart));
    return Buffer.concat([decipher.update(unb64(dataPart)), decipher.final()]).toString('utf8');
  } catch {
    // Either the key changed or the ciphertext was edited. Both are worth
    // knowing about; neither should leak detail to the caller.
    throw new AppError(
      'INTERNAL',
      'That bank account number could not be decrypted. It may have been altered, or the encryption key may have changed.',
    );
  }
}

/** Last four digits, kept in clear for recognition. */
export function last4(accountNumber: string): string {
  return accountNumber.slice(-4).padStart(4, '0');
}

/** For display: "•••• 4821". Never reconstructs the full number. */
export function maskAccount(last4Digits: string): string {
  return `•••• ${last4Digits}`;
}
