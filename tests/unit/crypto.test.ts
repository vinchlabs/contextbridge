import { describe, it, expect } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  ensureSodiumReady,
  encryptPayloadStream,
  decryptPayloadStream,
} from '../../src/core/crypto/encryption';
import { buildArchive } from '../../src/core/archive/writer';
import { readArchive, inspectArchiveHeader } from '../../src/core/archive/reader';
import { WrongPasswordError, ArchiveCorruptError } from '../../src/core/errors/errors';
import { ConversationSnapshot, CANONICAL_SCHEMA_VERSION, StoredBlob } from '../../src/core/model/canonical';

describe('Cryptographic Storage (Argon2id + XChaCha20-Poly1305)', () => {
  it('encrypts and decrypts payload stream with correct password', async () => {
    const s = await ensureSodiumReady();
    const password = 'CorrectHorseBatteryStaple#2026';
    const chunks = [
      new TextEncoder().encode('Header Chunk Data'),
      new TextEncoder().encode('Body Chunk Data 12345'),
    ];

    // Use min limits for fast test execution
    const encrypted = await encryptPayloadStream(
      chunks,
      password,
      s.crypto_pwhash_OPSLIMIT_MIN,
      s.crypto_pwhash_MEMLIMIT_MIN
    );

    expect(encrypted.chunks).toHaveLength(2);
    expect(encrypted.params.salt).toHaveLength(s.crypto_pwhash_SALTBYTES);
    expect(encrypted.params.header).toHaveLength(s.crypto_secretstream_xchacha20poly1305_HEADERBYTES);

    const decrypted = await decryptPayloadStream(encrypted.chunks, encrypted.params, password);
    expect(decrypted).toHaveLength(2);
    expect(new TextDecoder().decode(decrypted[0])).toBe('Header Chunk Data');
    expect(new TextDecoder().decode(decrypted[1])).toBe('Body Chunk Data 12345');
  });

  it('rejects decryption with incorrect password', async () => {
    const s = await ensureSodiumReady();
    const encrypted = await encryptPayloadStream(
      [new TextEncoder().encode('Secret Data')],
      'correct-password',
      s.crypto_pwhash_OPSLIMIT_MIN,
      s.crypto_pwhash_MEMLIMIT_MIN
    );

    await expect(
      decryptPayloadStream(encrypted.chunks, encrypted.params, 'wrong-password')
    ).rejects.toThrow(WrongPasswordError);
  });

  it('rejects tampered ciphertext', async () => {
    const s = await ensureSodiumReady();
    const encrypted = await encryptPayloadStream(
      [new TextEncoder().encode('Secret Data')],
      'password123',
      s.crypto_pwhash_OPSLIMIT_MIN,
      s.crypto_pwhash_MEMLIMIT_MIN
    );

    // Tamper ciphertext
    const tamperedChunk = new Uint8Array(encrypted.chunks[0]!);
    tamperedChunk[0]! ^= 0x55;

    await expect(
      decryptPayloadStream([tamperedChunk], encrypted.params, 'password123')
    ).rejects.toThrow(WrongPasswordError);
  });

  it('rejects truncated stream missing final chunk', async () => {
    const s = await ensureSodiumReady();
    const encrypted = await encryptPayloadStream(
      [new TextEncoder().encode('Part 1'), new TextEncoder().encode('Part 2')],
      'password123',
      s.crypto_pwhash_OPSLIMIT_MIN,
      s.crypto_pwhash_MEMLIMIT_MIN
    );

    // Omit the second (final) chunk
    await expect(
      decryptPayloadStream([encrypted.chunks[0]!], encrypted.params, 'password123')
    ).rejects.toThrow(ArchiveCorruptError);
  });

  it('full roundtrip for password-protected .ctxbridge file', async () => {
    const s = await ensureSodiumReady();
    const password = 'StrongPassword!987';

    const snapshot: ConversationSnapshot = {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      id: 'snap-encrypted-1',
      sourcePlatform: 'claude',
      title: 'Encrypted Confidential Chat',
      capturedAt: '2026-09-28T12:30:00Z',
      messages: [
        {
          id: 'msg-sec-1',
          role: 'user',
          sequence: 1,
          content: [{ type: 'text', text: 'Top secret plan details' }],
        },
      ],
      attachments: [],
    };
    const blobs = new Map<string, StoredBlob>();

    const encryptedArchive = await buildArchive(snapshot, blobs, {
      password,
      compress: true,
      customOpslimit: s.crypto_pwhash_OPSLIMIT_MIN,
      customMemlimit: s.crypto_pwhash_MEMLIMIT_MIN,
    });

    const header = inspectArchiveHeader(encryptedArchive);
    expect(header.isEncrypted).toBe(true);
    expect(header.isCompressed).toBe(true);

    // Decrypt without password fails
    await expect(readArchive(encryptedArchive)).rejects.toThrow(WrongPasswordError);

    // Decrypt with wrong password fails
    await expect(readArchive(encryptedArchive, { password: 'incorrect' })).rejects.toThrow(
      WrongPasswordError
    );

    // Decrypt with correct password succeeds
    const result = await readArchive(encryptedArchive, { password });
    expect(result.snapshot.id).toBe('snap-encrypted-1');
    expect(result.snapshot.title).toBe('Encrypted Confidential Chat');
    expect(result.snapshot.messages[0]?.content[0]).toEqual({
      type: 'text',
      text: 'Top secret plan details',
    });
  });
});
