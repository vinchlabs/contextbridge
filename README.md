# ContextBridge

Move a conversation from one AI chat to another, with its files and images, and keep going where you left off.

ContextBridge is a Firefox extension for ChatGPT, Claude and Gemini. It copies a whole chat, including history the page has not loaded yet, then pastes it into another AI's message box as a draft. Nothing is sent until you press Send. There is no ContextBridge server: everything happens in your browser.

## What it does

- **Copies the whole chat.** It scrolls through the virtualized history and keeps messages in order: text, code blocks with their language, tables, links and citations. Pictures and uploaded files are saved as bytes, not links.
- **Pastes it into another AI.** Recent messages go into the message box. Long chats also get the complete history as `transcript.md`. The original files and pictures are attached.
- **Checks the files.** A file counts as attached only once the page shows it, as a chip with its name or a preview. The notice on the page says what was attached and what still needs you.
- **Keeps within the limits.** Each site takes a limited number of files per message: Gemini 10, ChatGPT 10, Claude 20, `transcript.md` included. The newest files go first. The rest are listed so you can send them in your next message.
- **Names files consistently.** The pasted text refers to files by the names they are attached under (`[Image: plan.png]`, `[File not attached: notes.txt (2 KB)]`), so the model can match them up.
- **Saves chats as `.ctxbridge` archives.** These are compressed and can be protected with a password (Argon2id with XChaCha20-Poly1305). Open one later and continue in any supported chat.
- **Works with other AIs too.** For any other AI, use **Copy as text**, **Save .md** or **Save files**.

## Supported sites

| Site | Copy from | Paste into | Files per message |
| :--- | :---: | :---: | :---: |
| ChatGPT (`chatgpt.com`, `chat.openai.com`) | yes | yes | 10 |
| Claude (`claude.ai`) | yes | yes | 20 |
| Gemini (`gemini.google.com`) | yes | yes | 10 |

Chat sites change their pages often. If a copy or paste stops working, the popup's **Diagnostics** shows which page elements were found, without any conversation text.

## Privacy

- ContextBridge has no backend, no accounts, no analytics and no remote logging. You do not need an AI API key.
- The only network requests go to the chat site you are on and its file servers (such as `*.oaiusercontent.com` and `*.googleusercontent.com`). They fetch the pictures and files that belong to the open conversation, using your existing session.
- The copied chat is kept in `storage.session` (memory). Chats over about 8 MB go to `storage.local`, which is wiped when Firefox starts. **Clear** removes the copy at once.
- Passwords for `.ctxbridge` files are never stored. Keys are wiped from memory after use.

See [SECURITY.md](SECURITY.md) for the threat model, the archive hardening and the permissions.

## Install from source

You need [Node.js](https://nodejs.org/) 22+, [pnpm](https://pnpm.io/) 10+ and Firefox 115+.

```bash
git clone https://github.com/vinchlabs/contextbridge.git
cd contextbridge
pnpm install
pnpm build:firefox
```

Then load it in Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and choose `.output/firefox-mv3/manifest.json`.
3. The ContextBridge button appears in the toolbar. Temporary add-ons are removed when Firefox restarts.
4. Firefox grants site access one site at a time. When the popup says so, press **Allow on ...** for the chat site and **Allow pictures** for the servers its pictures come from (Gemini: `*.googleusercontent.com`, `lh3.google.com`). Without the second one, Gemini pictures cannot be copied.

## Use it

1. Open a chat on ChatGPT, Claude or Gemini, click the ContextBridge button and press **Copy this chat**. The copy keeps running if you close the popup. If a file cannot be read, the copy stops and names it. You can then try again, press **Skip missing file**, or copy only the text.
2. Open the chat where you want to continue and press **Paste into this chat**. You can also pick a site under **Start a new chat in**.
3. Read the notice on the page, check the draft and the attached files, then press Send.

The copied chat stays until Firefox restarts or you press **Clear**. **Save as .ctxbridge file** keeps it for longer. **Open .ctxbridge file** opens a tab, because Firefox closes the popup when a file picker appears.

## How it works

```text
chat page ──► adapter (crawler + extractor) ──► canonical snapshot + SHA-256 blobs
                                                   │
                         tray (copied chat) ◄──────┘
                                                   │
target page ◄── composer importer ◄── handoff (prompt, transcript.md, attachment plan)
```

- **Adapters** (`src/adapters/<site>/`) read one site. ChatGPT and Gemini are read from the page: the crawler walks the virtualized history, and the extractor turns each turn into canonical messages in document order. ChatGPT's uploaded-file cards are read by replaying ChatGPT's own download requests. Claude is read through claude.ai's own conversation API, with the page as a fallback.
- **Core** (`src/core/`) is independent of the sites. It holds the canonical model, SHA-256 blob store, `.ctxbridge` reader and writer, compression, encryption, and the handoff builder.
- **The composer importer** (`src/adapters/composer-import.ts`) inserts the draft in a way ProseMirror and Quill editors register. It then offers the files through the page's upload input, a paste, or a drop, and checks that the page shows them.

More detail:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components and data flow.
- [docs/ADAPTERS.md](docs/ADAPTERS.md): how each site is read and filled in, and how to add a site.
- [docs/CTXBRIDGE_FORMAT.md](docs/CTXBRIDGE_FORMAT.md): the archive format.
- [docs/TESTING.md](docs/TESTING.md): the manual test checklist.

## Development

| Command | What it does |
| :--- | :--- |
| `pnpm dev:firefox` | Dev build with reload in Firefox |
| `pnpm build:firefox` | Production build in `.output/firefox-mv3` |
| `pnpm zip:firefox` | Packaged extension for distribution |
| `pnpm test` | Unit and integration tests (Vitest with happy-dom) |
| `pnpm typecheck` | TypeScript check |
| `pnpm lint` | ESLint on `src/` and `entrypoints/` |

```text
entrypoints/   background script, content scripts, popup (React)
src/adapters/  ChatGPT, Claude and Gemini adapters, shared composer importer
src/core/      canonical model, archive, crypto, hashing, handoff
src/storage/   tray, preferences, pending handoffs
src/utils/     messaging, page notice, byte helpers
tests/         unit and integration tests with DOM fixtures
docs/          architecture, adapters, archive format, manual tests
```

## Limitations

- Sites can refuse files that a script hands over. When that happens, the notice lists the files so you can attach them yourself. **Save files** gives you copies under the same names.
- Gemini shows files you uploaded (CSV, PDF and so on) only as chips, without their contents. ContextBridge copies their names and marks them as not included; attach the originals yourself. Pictures and generated videos are copied.
- Only Gemini takes audio and video. When pasting into ChatGPT or Claude, those files are listed instead of attached.
- A model only sees what fits in its context window. Long chats rely on the model reading `transcript.md`.
- Hidden provider state is not visible in the page, so it cannot be copied. That includes system prompts, memory and hidden reasoning.
- Firefox only for now.

## License

[Apache License 2.0](LICENSE). Copyright 2026 vinchlabs.
