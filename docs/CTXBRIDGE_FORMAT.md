# ContextBridge Archive Specification (v1)

- **File Extension:** `.ctxbridge`
- **MIME Type:** `application/x-contextbridge`
- **Format Version:** `1`
- **Magic Identifier:** `CTXBRDG1` (8 ASCII bytes: `0x43 0x54 0x58 0x42 0x52 0x44 0x47 0x31`)

This specification documents the physical structure, framing, schemas, cryptographic operations, and validation rules for **ContextBridge Archive v1** (`.ctxbridge`). Any compliant parser can reconstruct the canonical conversation and binary attachments losslessly by following this specification.

---

## 1. Outer Container Layout

A `.ctxbridge` file begins with a fixed binary header, followed either directly by the payload or by cryptographic KDF parameters and an authenticated ciphertext stream.

All multi-byte numeric fields are stored in **big-endian (network byte order)**.

### 1.1 Unencrypted Archive Layout

```text
+-------------------+--------------------+------------------+-----------------------+
| Magic (8 bytes)   | Version (2 bytes)  | Flags (2 bytes)  | Payload Bytes (N B)   |
| 'C''T''X''B'      | uint16 = 1         | uint16           | Uncompressed or       |
| 'R''D''G''1'      |                    | 0x0000 or 0x0002 | Deflate-raw Stream    |
+-------------------+--------------------+------------------+-----------------------+
0                   8                    10                 12                      12 + N
```

- **Magic (8 bytes):** ASCII bytes `CTXBRDG1` (`[0x43, 0x54, 0x58, 0x42, 0x52, 0x44, 0x47, 0x31]`).
- **Version (2 bytes):** Big-endian unsigned 16-bit integer. Must equal `1`.
- **Flags (2 bytes):** Big-endian bitfield:
  - `0x0001` (`FLAG_ENCRYPTED`): `0` = Plaintext, `1` = Encrypted.
  - `0x0002` (`FLAG_COMPRESSED`): `0` = Raw payload, `1` = Compressed using Deflate (`deflate-raw`).
  - Bits 2–15: Reserved (must be set to `0`).

---

### 1.2 Encrypted Archive Layout

When bit 0 of `Flags` (`0x0001`) is set:

```text
+----------------------+--------------------+--------------------+
| Magic (8 bytes)      | Version (2 bytes)  | Flags (2 bytes)    |
| 'CTXBRDG1'           | uint16 = 1         | uint16 (0x0001|...) |
+----------------------+--------------------+--------------------+
0                      8                    10                   12

+----------------------+--------------------+--------------------+
| KDF Alg (1 byte)     | Opslimit (4 bytes) | Memlimit (4 bytes) |
| 0x01 (Argon2id)      | uint32 BE          | uint32 BE          |
+----------------------+--------------------+--------------------+
12                     13                   17                   21

+----------------------+-----------------------------------------+
| Salt (16 bytes)      | SecretStream Header (24 bytes)          |
| Raw binary salt      | libsodium xchacha20poly1305 header      |
+----------------------+-----------------------------------------+
21                     37                                        61

+----------------------------------------------------------------+
| Encrypted Chunks Stream ...                                    |
| [4-byte Chunk Length uint32 BE][Ciphertext Chunk Bytes] ...    |
+----------------------------------------------------------------+
61                                                               End
```

#### Cryptographic Parameters:
1. **Key Derivation (KDF):**
   - **Algorithm (1 byte):** `0x01` represents Argon2id (`crypto_pwhash_ALG_ARGON2ID13`).
   - **Opslimit (4 bytes BE):** Iteration count limit (e.g., `crypto_pwhash_OPSLIMIT_INTERACTIVE`).
   - **Memlimit (4 bytes BE):** Memory limit in bytes (e.g., `crypto_pwhash_MEMLIMIT_INTERACTIVE`).
   - **Salt (16 bytes):** 16 cryptographically random bytes (`crypto_pwhash_SALTBYTES`).
   - **Derived Key:** 32-byte (256-bit) symmetric key derived via `crypto_pwhash`.
2. **Authenticated Ciphertext Stream:**
   - **Cipher:** XChaCha20-Poly1305 SecretStream (`crypto_secretstream_xchacha20poly1305`).
   - **Header (24 bytes):** SecretStream initialization header (`crypto_secretstream_xchacha20poly1305_init_push`).
   - **Framing:** Each encrypted chunk begins with a 4-byte big-endian unsigned length, followed by the ciphertext chunk produced by `crypto_secretstream_xchacha20poly1305_push`.
   - **Tags:** Intermediate chunks use `TAG_MESSAGE` (`0x00`). The terminal chunk must use `TAG_FINAL` (`0x03`). Decryption terminates with `WrongPasswordError` if tags fail verification or if stream ends without `TAG_FINAL`.

---

## 2. Uncompressed Archive Payload Structure

Once decrypted (if encrypted) and decompressed (if `FLAG_COMPRESSED` is set), the payload consists of sequential framed records:

```text
+--------------------+----------------------+-----------------------+
| Record Tag (4 B)   | Payload Length (4 B) | Record Data (N Bytes) |
| ASCII Tag          | uint32 BE            | Record Body           |
+--------------------+----------------------+-----------------------+
```

### Record Tags:

| Tag | Name | Contents |
| :--- | :--- | :--- |
| `META` | Archive Manifest | CBOR (RFC 8949) encoded `ArchiveManifest` record. |
| `CONV` | Conversation Snapshot | CBOR (RFC 8949) encoded canonical `ConversationSnapshot`. |
| `BLOB` | Content-Addressed Blob | Binary SHA-256 digest + CBOR metadata + raw binary payload. |
| `EOF_` | Terminal Record | Marker indicating end of archive (`Payload Length` = 0). |

---

### 2.1 The `BLOB` Record Layout

Each binary attachment (image, PDF, code file, document) is stored in a dedicated `BLOB` record:

```text
+-----------------------+-----------------------+---------------------+---------------------+
| SHA-256 (32 bytes)    | Meta Length (4 bytes) | CBOR Metadata (M B) | Raw Binary Data (K) |
| Binary 32-byte digest | uint32 BE             | CBOR Map            | K = Declared Length |
+-----------------------+-----------------------+---------------------+---------------------+
0                       32                      36                    36 + M                36 + M + K
```

- **SHA-256 (32 bytes):** The exact binary SHA-256 cryptographic digest of the raw binary data.
- **Meta Length (4 bytes):** Unsigned 32-bit big-endian integer giving byte size `M` of CBOR metadata.
- **CBOR Metadata:** A compact CBOR map containing:
  ```json
  {
    "mimeType": "image/png",
    "byteSize": 1048576,
    "filename": "diagram.png",
    "role": "user-upload",
    "captureSource": "https://...",
    "originalUrl": "https://..."
  }
  ```
- **Raw Binary Data:** Exactly `byteSize` bytes of untouched binary content (no base64 encoding).
- **Integrity Check:** The parser **must** compute the SHA-256 hash of the `Raw Binary Data` and reject the archive with `ArchiveCorruptError` if it does not match the 32-byte header hash.

---

## 3. CBOR Schemas (RFC 8949)

### 3.1 `ArchiveManifest` (`META` Record)

```typescript
{
  schemaVersion: 1,
  generator: "ContextBridge v1.0.0",
  createdAt: "2026-09-28T12:00:00.000Z",
  sourcePlatform: "chatgpt" | "gemini" | "claude" | string,
  title?: string,
  messageCount: number,
  attachmentCount: number,
  totalBlobBytes: number
}
```

### 3.2 `ConversationSnapshot` (`CONV` Record)

```typescript
{
  schemaVersion: 1,
  id: string,
  sourcePlatform: "chatgpt" | "gemini" | "claude" | string,
  sourceConversationId?: string,
  title?: string,
  sourceUrl?: string,
  capturedAt: string, // ISO 8601
  messages: Message[],
  attachments: BlobMetadata[],
  metadata?: Record<string, unknown>
}
```

### 3.3 `Message` Schema

```typescript
{
  id: string,
  role: "user" | "assistant" | "system" | "tool",
  sequence: number, // 1-based chronological index
  createdAt?: string, // ISO 8601
  content: ContentPart[],
  metadata?: Record<string, unknown>
}
```

### 3.4 `ContentPart` Schemas

Content parts form a discriminated union based on `type`:

1. **Text:** `{ type: "text", text: string }`
2. **Markdown:** `{ type: "markdown", markdown: string }`
3. **Code:** `{ type: "code", code: string, language?: string, title?: string }`
4. **Image:** `{ type: "image", blobSha256: string, altText?: string, mimeType?: string, width?: number, height?: number }`
5. **File:** `{ type: "file", blobSha256: string, filename: string, mimeType: string, byteSize?: number }`
6. **Link:** `{ type: "link", url: string, title?: string }`
7. **Citation:** `{ type: "citation", text: string, url?: string, title?: string, startIndex?: number, endIndex?: number }`
8. **Table:** `{ type: "table", headers: string[], rows: string[][], caption?: string }`
9. **Tool Result:** `{ type: "tool-result", toolName?: string, input?: unknown, output: string | unknown, status?: "success" | "error" }`
10. **Unknown / Forward-Compatible:** `{ type: "unknown", rawText?: string, platformType?: string, metadata?: Record<string, unknown> }`

---

## 4. Implementation Limits & Sanity Bounds

To protect parser implementations from malicious memory bombs or CPU exhaustion attacks:

| Resource | Upper Limit | Action on Exceeding |
| :--- | :--- | :--- |
| **Messages per archive** | 100,000 | Reject with `SecurityBoundsExceededError` |
| **Content parts per message** | 1,000 | Reject with `SecurityBoundsExceededError` |
| **Attachments per archive** | 10,000 | Reject with `SecurityBoundsExceededError` |
| **Text part length** | 50 MB | Reject with `SecurityBoundsExceededError` |
| **Individual record length** | 2 GB | Reject with `SecurityBoundsExceededError` |
| **Title / string length** | 2,048 chars | Reject with `SecurityBoundsExceededError` |

---

## 5. Forward Compatibility Rules

1. Parsers encountering an unknown record tag (any 4-character tag other than `META`, `CONV`, `BLOB`, `EOF_`) must skip the record by advancing the file pointer by `8 + Length` bytes.
2. Parsers encountering an unknown `ContentPart.type` must preserve the object as-is and may display fallback text representation without erroring.
3. Extra attributes in CBOR maps must be ignored rather than triggering schema validation errors.
