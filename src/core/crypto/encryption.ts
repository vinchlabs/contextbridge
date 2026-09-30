/**
 * Cryptographic implementation using libsodium (Argon2id + XChaCha20-Poly1305 SecretStream)
 */

import sodium from 'libsodium-wrappers-sumo';
import { WrongPasswordError, ArchiveCorruptError, SecurityBoundsExceededError } from '../errors/errors';

export const KDF_ALGORITHM_ARGON2ID13 = 1 as const;

export interface EncryptionParams {
  kdfAlgorithm: number;
  opslimit: number;
  memlimit: number;
  salt: Uint8Array;
  header: Uint8Array;
}

export interface EncryptedStreamResult {
  params: EncryptionParams;
  chunks: Uint8Array[];
}

/**
 * Initializes and awaits the libsodium library.
 */
export async function ensureSodiumReady(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}

/**
 * Derives a 256-bit encryption key from a password using Argon2id.
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  opslimit?: number,
  memlimit?: number
): Promise<Uint8Array> {
  const s = await ensureSodiumReady();

  if (salt.length !== s.crypto_pwhash_SALTBYTES) {
    throw new ArchiveCorruptError(`Invalid salt length: expected ${s.crypto_pwhash_SALTBYTES}, got ${salt.length}`);
  }

  const ops = opslimit ?? s.crypto_pwhash_OPSLIMIT_INTERACTIVE;
  const mem = memlimit ?? s.crypto_pwhash_MEMLIMIT_INTERACTIVE;

  try {
    const key = s.crypto_pwhash(
      s.crypto_secretstream_xchacha20poly1305_KEYBYTES,
      password,
      salt,
      ops,
      mem,
      s.crypto_pwhash_ALG_ARGON2ID13
    );
    return key;
  } catch (err) {
    throw new ArchiveCorruptError('Failed to derive encryption key via Argon2id', err);
  }
}

/**
 * Encrypts an array of plaintext chunks using XChaCha20-Poly1305 SecretStream.
 * Handles single or multiple chunks, marking the last chunk with TAG_FINAL.
 */
export async function encryptPayloadStream(
  chunks: Uint8Array[],
  password: string,
  customOpslimit?: number,
  customMemlimit?: number
): Promise<EncryptedStreamResult> {
  const s = await ensureSodiumReady();

  const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
  const opslimit = customOpslimit ?? s.crypto_pwhash_OPSLIMIT_INTERACTIVE;
  const memlimit = customMemlimit ?? s.crypto_pwhash_MEMLIMIT_INTERACTIVE;

  const key = await deriveKey(password, salt, opslimit, memlimit);

  try {
    const initPush = s.crypto_secretstream_xchacha20poly1305_init_push(key);
    const header = new Uint8Array(initPush.header);
    const state = initPush.state;

    const encryptedChunks: Uint8Array[] = [];

    if (chunks.length === 0) {
      // Empty payload edge case
      const emptyChunk = s.crypto_secretstream_xchacha20poly1305_push(
        state,
        new Uint8Array(0),
        null,
        s.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      );
      encryptedChunks.push(new Uint8Array(emptyChunk));
    } else {
      for (let i = 0; i < chunks.length; i++) {
        const isFinal = i === chunks.length - 1;
        const chunk = chunks[i] ?? new Uint8Array(0);
        const tag = isFinal
          ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL
          : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;

        const ciphertext = s.crypto_secretstream_xchacha20poly1305_push(state, chunk, null, tag);
        encryptedChunks.push(new Uint8Array(ciphertext));
      }
    }

    return {
      params: {
        kdfAlgorithm: KDF_ALGORITHM_ARGON2ID13,
        opslimit,
        memlimit,
        salt: new Uint8Array(salt),
        header,
      },
      chunks: encryptedChunks,
    };
  } finally {
    // Clear key from memory
    s.memzero(key);
  }
}

/**
 * Decrypts a sequence of encrypted chunks using XChaCha20-Poly1305 SecretStream.
 * Throws WrongPasswordError or ArchiveCorruptError on authentication failure or truncation.
 */
export async function decryptPayloadStream(
  encryptedChunks: Uint8Array[],
  params: EncryptionParams,
  password: string
): Promise<Uint8Array[]> {
  const s = await ensureSodiumReady();

  if (params.kdfAlgorithm !== KDF_ALGORITHM_ARGON2ID13) {
    throw new ArchiveCorruptError(`Unsupported KDF algorithm: ${params.kdfAlgorithm}`);
  }

  if (params.header.length !== s.crypto_secretstream_xchacha20poly1305_HEADERBYTES) {
    throw new ArchiveCorruptError(
      `Invalid secretstream header length: expected ${s.crypto_secretstream_xchacha20poly1305_HEADERBYTES}, got ${params.header.length}`
    );
  }

  // KDF parameters come from the (untrusted) archive header: bound them so a crafted file cannot
  // freeze the popup (huge opslimit) or exhaust WebAssembly memory (huge memlimit).
  const maxOps = s.crypto_pwhash_OPSLIMIT_SENSITIVE;
  const maxMem = s.crypto_pwhash_MEMLIMIT_MODERATE;
  if (params.opslimit < s.crypto_pwhash_OPSLIMIT_MIN || params.opslimit > maxOps) {
    throw new SecurityBoundsExceededError('KDF opslimit', maxOps, params.opslimit);
  }
  if (params.memlimit < s.crypto_pwhash_MEMLIMIT_MIN || params.memlimit > maxMem) {
    throw new SecurityBoundsExceededError('KDF memlimit', maxMem, params.memlimit);
  }

  const key = await deriveKey(password, params.salt, params.opslimit, params.memlimit);

  let state: any;
  try {
    state = s.crypto_secretstream_xchacha20poly1305_init_pull(params.header, key);
  } catch (err) {
    s.memzero(key);
    throw new WrongPasswordError(err);
  }

  const decryptedChunks: Uint8Array[] = [];
  let reachedFinal = false;

  try {
    for (let i = 0; i < encryptedChunks.length; i++) {
      const chunk = encryptedChunks[i]!;
      let pullResult: { message: Uint8Array; tag: number } | false;

      try {
        pullResult = s.crypto_secretstream_xchacha20poly1305_pull(state, chunk, null);
      } catch (err) {
        throw new WrongPasswordError(err);
      }

      if (!pullResult || typeof pullResult !== 'object') {
        throw new WrongPasswordError('Authentication tag verification failed');
      }

      decryptedChunks.push(new Uint8Array(pullResult.message));

      if (pullResult.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
        reachedFinal = true;
        // Chunks after final are illegal
        if (i !== encryptedChunks.length - 1) {
          throw new ArchiveCorruptError('Superfluous chunks after stream final tag');
        }
        break;
      }
    }

    if (!reachedFinal) {
      throw new ArchiveCorruptError('Encrypted stream truncated: TAG_FINAL never reached');
    }

    return decryptedChunks;
  } finally {
    s.memzero(key);
  }
}
