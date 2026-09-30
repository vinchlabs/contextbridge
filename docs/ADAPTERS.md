# Platform Adapters Architecture — ContextBridge

ContextBridge isolates platform-specific DOM parsing, scrolling, and composer automation from the platform-independent core through the `ChatAdapter` interface.

---

## 1. The `ChatAdapter` Contract

Every platform adapter implements the standard TypeScript interface defined in `src/adapters/adapter.ts`:

```typescript
export interface ChatAdapter {
  readonly id: PlatformId;
  readonly displayName: string;
  readonly supportedHostnames: string[];

  detect(url?: string): boolean;
  getConversationMetadata(doc?: Document): Promise<ConversationMetadata>;
  captureConversation(
    options?: CaptureOptions,
    onProgress?: (progress: CaptureProgress) => void,
    signal?: AbortSignal,
    doc?: Document
  ): Promise<{ snapshot: ConversationSnapshot; blobs: Map<string, StoredBlob> }>;

  prepareImport(
    bundle: { snapshot: ConversationSnapshot; blobs: Map<string, StoredBlob> },
    options?: ImportOptions
  ): Promise<PreparedHandoff>;

  injectHandoff(
    handoff: PreparedHandoff,
    doc?: Document
  ): Promise<ImportResult>;

  getDiagnostics(doc?: Document): Promise<AdapterDiagnostics>;
}
```

---

## 2. Capture Lifecycle

When an export or continuation workflow begins, the adapter executes a 5-phase capture lifecycle:

```text
1. Detecting       -->  Verifies URL, inspects active page, extracts conversation title & metadata
2. Crawling        -->  Locates scroll container, crawls virtualized history upwards, deduplicates
3. Extracting      -->  Parses message roles, code blocks, tables, citations, and media references
4. Resolving Media -->  Fetches authenticated image/file blobs into content-addressed BlobStore
5. Finalizing      -->  Sorts messages chronologically, verifies schema, constructs snapshot
```

---

## 3. Virtualized DOM Strategy

AI chat applications (ChatGPT, Gemini, Claude) virtualize long conversations to preserve browser performance, unmounting historical turns from the DOM when they scroll out of view.

ContextBridge solves this using a pass-aware virtual crawler:

1. **Scroll Container Detection:** Identifies the scrollable container using centralized selector cascades (`main`, `[class*="react-scroll-to-bottom"]`, `infinite-scroller`, or `window.document.scrollingElement`).
2. **Current View Scan:** Records currently visible message turns in an in-memory map keyed by stable turn identifiers (`data-testid="conversation-turn-X"`, `user-query`, `[data-message-id]`).
3. **Upward Scrolling:** Programmatically steps `scrollTop` upward by ~800 pixels.
4. **MutationObserver Sync:** Observes the container using `MutationObserver` to detect DOM additions rather than sleeping for arbitrary fixed delays.
5. **Deduplication:** Newly rendered historical elements are merged into the captured map.
6. **Termination Conditions:**
   - Scroll reaches top (`scrollTop <= 0`) and no new turns appear after 3 consecutive attempts.
   - Max scroll attempt limit reached.
   - User aborts via `AbortSignal`.
7. **Chronological Reconstruction:**
   - If explicit turn IDs are available (e.g., `conversation-turn-12`), turns are ordered numerically.
   - Otherwise, turns are sorted by reverse pass index (`b.passIndex - a.passIndex`), followed by local DOM order within that pass.
   - The user's original scroll position is restored upon completion.

---

## 4. Attachment & Media Resolution

1. Message extractors flag media URLs (`https://...`, `blob:...`, `data:...`) for pictures, videos and audio.
2. The attachment extractor fetches the bytes from the content script (session cookies for the page's own origin). Cross-origin media without CORS headers (Gemini's `googleusercontent.com`) is fetched by the background instead (`FETCH_MEDIA`): only for supported chat tabs, only `GET` on https URLs covered by the extension's host permissions (after redirects too), at most 100 MB. Firefox treats MV3 host permissions as opt-in, so the background first checks that the user has allowed the host (`permissions.contains`) and otherwise reports `no permission for <host>`; the popup offers **Allow pictures** for the platform's `mediaOrigins` (`src/core/platforms.ts`). When that fails too, the background asks the chat page to read the URL itself in the MAIN world (`src/utils/page-fetch-main-world.ts`, `scripting.executeScript`). Firefox keeps the page's Google session out of the extension's own requests, content scripts may not load the page's `blob:` URLs, and Gemini's CSP (`connect-src` without `blob:`) forbids fetching them. So the page reads, in order: a `blob:` picture it shows through a canvas, the URL with its own `fetch()` (session first, then without), and for pictures the URL again as a CORS image (Google's image hosts allow the page's origin) or the picture it shows. Pixels come back as PNG. The page's reads stay under its own CORS and CSP rules and are limited to the host permissions, `lh3.google.com`, `*.ggpht.com`, the page's own origin and the page's own `blob:` URLs (`isPageFetchAllowed`, final URL checked again), at most 100 MB. A picture the page already shows is also read back through a canvas in the content script. When everything fails, the error names each file with its origin (never a path or token) and how every step failed.
3. Content is stored in a `BlobStore` that hashes the payload via SHA-256:
   - If two messages reference the exact same image or file, it is deduplicated and stored once.
4. Message content references replace temporary URLs with the permanent `blobSha256` identity. Every upload that stays unreadable is named in one error, so a single **Skip missing file** covers them all.

**Claude** is read through claude.ai's own conversation API, the one its web app uses: `GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true` returns every message of the visible branch (Claude's replies and artifacts included), the files of each message (bytes from `/api/organizations/{org}/files/{uuid}/contents`, then `/preview`, then `/thumbnail`) and the text of pasted or extracted documents. Requests are same-origin with the session; thinking blocks and tool results are not copied. When the API is unavailable, the adapter reads the page (`.font-claude-response`, `[data-is-streaming]`, `[data-testid="user-message"]`).

**Gemini** has no message API, so turns are read from the page in document order (`src/adapters/content-walker.ts`), skipping Gemini's chrome ("You said" labels, "Show thinking", sources, action bars). The prompt text comes only from `.query-text`. Uploaded files appear as chips ("CSV" and a name) without a download link in the page; they become named file references that the capture reports as unreadable, and after **Skip missing file** as "not included" markers. Generated videos are captured as files.

**ChatGPT uploaded-file cards** have no URL in the DOM. `file-card-resolver.ts` clicks each card while MAIN-world hooks (`file-capture-main-world.ts`) watch ChatGPT's own chain: `files/{id}/simple` → `files/download/{id}` → `download_url` (estuary). The bytes the page fetches are cloned; otherwise the exact `download_url` is fetched.

When ChatGPT shows a preview from its cache, only `files/{id}/simple` goes out. The hooks then repeat ChatGPT's own `files/download` request for that id, with the URL query and headers ChatGPT used in this session. Those headers never leave the MAIN-world closure. Cards still missing after the scroll pass get one more try without a click (late pass).

Anything still unread fails the capture and names the files, unless the user picks **Skip missing file** (`allowMissingFiles`); those files then become "not included" markers.

---

## 5. Target Composer Importer

Continuation into a target AI application automates the active compose box:

- **Rich Text & Controlled Inputs:** Assigning `.value` alone fails in ProseMirror, Lexical, and React controlled components. The importer focuses the element, updates `textContent`/`value`, and dispatches synthetic `InputEvent` (`inputType: 'insertText'`) and `Event('change')`.
- **Attaching files, verified:** `attachFiles` in `src/adapters/composer-import.ts` tries the target's `input[type="file"]` (assign `files`, dispatch `input` and `change`), then a `paste` event on the composer, then `dragenter`/`dragover`/`drop` (re-aimed at whatever element covers the composer, since sites open a drop area). After each way it watches the page for the file names or new `blob:`/`data:` previews (`<img>`, `<source>`, CSS backgrounds) outside the editor and ContextBridge's own notice, and stops at the first way that shows anything, so files are not added twice. A way the page reacted to (it cancelled the paste or drop, or emptied its upload input after reading it) gets up to 10 s instead of 3 s before the next way is tried, so a slow site does not get a second copy.
- **Firefox Xrays:** a `DataTransfer` filled from a content script keeps the extension as owner of its items, and the page then reads an empty file list. The importer builds it through `window.wrappedJSObject.DataTransfer`, and Firefox's `ClipboardEvent` ignores `clipboardData` in its init dictionary, so the files go into the event's own `DataTransfer` through the page's view of the event.
- **Limits and names:** the handoff sends at most the target's per-message file limit (`maxFilesPerMessage` in `src/core/platforms.ts`), newest files first. The text names each file as it is attached (`[Image: plan.png]`, `[File not attached: notes.txt (2 KB)]`), and image types come from the bytes, not from the alt text.
- **Honest fallback:** files the page did not show (`filesNotConfirmed`), files the page reacted to but never showed (`filesUnverified`: "check before you send", not "attach again") and files over the limit (`filesOverLimit`) are listed in the in-page notice and the popup; Save files and Save .md give copies under the same names.

---

## 6. How to Add a New AI Provider

To add support for a new AI service (e.g., HuggingChat, Perplexity, Mistral Le Chat):

1. **Create Adapter Directory:** `src/adapters/<provider>/`
2. **Define Selectors (`selectors.ts`):** Document CSS/ARIA selectors for turns, roles, prose, code blocks, tables, and compose input.
3. **Implement Extractor (`extractor.ts`):** Map provider-specific DOM turns into canonical `Message` and `ContentPart` records.
4. **Implement Crawler (`crawler.ts`):** Adapt the virtual crawler for the provider's scroll container.
5. **Implement Importer (`importer.ts`):** Target the provider's prompt box and file input.
6. **Assemble Adapter (`adapter.ts`):** Implement `ChatAdapter`.
7. **Register in Registry (`src/adapters/registry.ts`):** Add `new ProviderAdapter()` to `ADAPTERS`.
8. **Add Content Script Entrypoint:** `entrypoints/<provider>.content.ts` with matching URL glob.
9. **Update Manifest Permissions:** Add host URL to `wxt.config.ts`.
10. **Add Tests:** Add sanitized HTML fixture to `tests/fixtures/` and integration tests.
