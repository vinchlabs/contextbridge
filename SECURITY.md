# Security Model & Policy — ContextBridge

## 1. Absolute Privacy & Local-First Architecture

ContextBridge is engineered with a strict **Zero-Backend, Local-First** security philosophy:

- **No Remote Infrastructure:** There are no ContextBridge servers, databases, or API gateways.
- **No Telemetry or Tracking:** Zero analytics SDKs, error trackers, tracking pixels, or remote telemetry.
- **No Third-Party Transmission:** Conversation data, transcripts, and media are never transmitted over the network to any third party.
- **Minimal Network Access:** Network requests (`fetch`) go only to the AI provider of the open chat and its file servers: the conversation's own pictures, videos and files, and for Claude the conversation itself through claude.ai's own API (same-origin, with the existing session). Cross-origin media the page cannot hand over (no CORS headers) is fetched by the background script, only for supported chat tabs, only `GET` on https URLs within the extension's host permissions (checked again after redirects), and at most 100 MB per file. If the extension's own request is refused (Firefox does not give it the page's Google session), the background has the chat page read the file itself: with the page's own `fetch()`, or for pictures by drawing them on a canvas. Same session, same CORS and CSP rules as the page's scripts, so it reads nothing the page could not. That path is limited to the host permissions, Google's image hosts (`lh3.google.com`, `*.ggpht.com`), the page's own origin and the page's own `blob:` URLs, with the final URL checked again.

---

## 2. Threat Model & Trust Boundaries

ContextBridge manages sensitive conversational data across four distinct trust boundaries:

| Boundary | Trust Level | Mitigation / Policy |
| :--- | :--- | :--- |
| **Provider Web Page (DOM)** | Untrusted / Adversarial | DOM data is treated strictly as passive data. Script elements, event handlers, and executable payloads are never executed. |
| **Imported `.ctxbridge` Files** | Untrusted Input | Strict schema validation, magic header verification, SHA-256 integrity validation, hard memory bounds, and safe binary decoding. |
| **Target AI Platform Compose Box** | Semi-trusted External | Context handoffs are injected as drafts into user-visible compose inputs; user retains final send control. |
| **Local Device & Browser Storage** | Trusted Host | Passwords and derived encryption keys are ephemeral and wiped from memory after use (`sodium.memzero`). |

---

## 3. Defense Against Prompt Injection & Malicious Content

Conversations with AI models frequently contain prompt injections, executable code samples, and adversarial instructions:

- **Data is Strictly Data:** All extracted messages, tool outputs, citations, and metadata are represented in strongly typed JSON/CBOR structures. They are never evaluated as extension code, shell scripts, or browser commands (`eval`, `Function`, `innerHTML` on privileged surfaces are strictly avoided).
- **No Privileged Execution:** Extracted text cannot trigger extension-privileged WebExtension APIs.
- **Transcript Sanitization:** The Markdown renderer escapes table delimiters and formats code blocks within standard fences to prevent unintended formatting distortion.

---

## 4. Archive Parsing & Deserialization Hardening

Imported `.ctxbridge` files are treated as untrusted external inputs:

- **Magic Byte Validation:** Files must begin with the fixed 8-byte ASCII sequence `CTXBRDG1`. Any malformed or altered header is rejected immediately.
- **Version Enforcement:** Only supported archive schema versions (v1) are processed. Future or incompatible versions trigger a typed `UnsupportedArchiveVersionError`.
- **DoS & Decompression Bomb Protection:**
  - Maximum messages per conversation: 100,000
  - Maximum content parts per message: 1,000
  - Maximum attachments: 10,000
  - Maximum text part length: 50 MB
  - Maximum record byte size: 2 GB
- **No Zip-Slip / Path Traversal:** Blobs are indexed in memory and inside the archive container **strictly by their cryptographic SHA-256 hash**, never by arbitrary filesystem paths. Malicious filename values (such as `../../../../etc/passwd`) have no effect on storage or resolution.
- **Cryptographic Blob Integrity:** When parsing unencrypted and decrypted archives, the raw bytes of every binary blob are hashed via SHA-256 and verified against the declared digest. Corrupted or tampered blobs cause immediate parsing rejection.

---

## 5. Cryptography & Password Protection

Optional archive encryption adheres to modern, audited cryptographic standards:

- **Key Derivation (KDF):** Argon2id (`crypto_pwhash_ALG_ARGON2ID13`) implemented via libsodium WASM.
  - A cryptographically secure random 16-byte salt (`randombytes_buf`) is generated for every encrypted export.
  - Interactive opslimit and memlimit provide resistance to GPU-based brute-force attacks.
- **Authenticated Encryption:** XChaCha20-Poly1305 SecretStream (`crypto_secretstream_xchacha20poly1305`).
  - Provides AEAD confidentiality and integrity.
  - Each chunk is authenticated with a Poly1305 MAC.
  - The final chunk is verified using `TAG_FINAL`. Truncated or stripped streams are detected and rejected.
- **Wrong Password & Tamper Detection:** Any tampering with the ciphertext, salt, secretstream header, or entering an incorrect password causes libsodium authentication to fail immediately. ContextBridge safely terminates decryption and raises `WrongPasswordError`.
- **Memory Zeroing:** Sensitive key buffers are wiped using `sodium.memzero()` immediately after encryption or decryption completes. Plaintext passwords and derived keys are never written to disk or extension storage.

---

## 6. WebExtension Permissions Rationale

ContextBridge requests only the minimum set of permissions necessary for local operation:

| Permission | Purpose |
| :--- | :--- |
| `activeTab` | Allows the extension to interact with the currently focused AI provider tab when clicked. |
| `scripting` | Enables content script execution for DOM crawling and handoff injection, and small fixed functions in the chat page's MAIN world (ChatGPT file capture, reading a picture with the page's own session). |
| `downloads` | Saves `.ctxbridge` archives and exported Markdown transcripts to the user's local Downloads folder. |
| `storage` | Holds the copied chat between "Copy" and "Paste": in `storage.session` (memory only), or for chats above ~8 MB in `storage.local`, which is wiped on every browser start. **Clear** removes it at once. Also stores small UI preferences, the last handoff outcome and sanitized diagnostics. Passwords are never stored. |
| `https://chatgpt.com/*`<br>`https://chat.openai.com/*`<br>`https://gemini.google.com/*`<br>`https://claude.ai/*` | Host permissions restricted specifically to the supported AI provider domains to fetch authenticated media and automate compose boxes. |
| `https://*.googleusercontent.com/*`<br>`https://lh3.google.com/*`<br>`https://*.oaiusercontent.com/*`<br>`https://*.openai.com/*` | The servers the chats' pictures and files come from (Gemini, ChatGPT). Used only for `GET` requests for media the open chat shows. In Firefox, MV3 host permissions are opt-in: allowing a chat site does not allow these, so the popup asks for them ("Allow pictures") when they are missing. |

*Note: ContextBridge does **not** request `<all_urls>` permission.*

---

## 7. Reporting Security Issues

If you discover a potential vulnerability in ContextBridge, please report it via private security advisory on GitHub rather than filing a public issue.
