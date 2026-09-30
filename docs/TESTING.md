# Manual test checklist (Firefox)

Automated tests (`pnpm test`) cover the model, archive, crypto, handoff and DOM extraction against fixtures. The chat sites themselves change often, so check these by hand before a release.

## Copy

- [ ] **Short ChatGPT chat:** Copy completes; **Save .ctxbridge** downloads the archive.
- [ ] **Long, virtualized ChatGPT chat:** the crawler scrolls up, captures every message and restores the scroll position.
- [ ] **Code blocks:** language and indentation are kept.
- [ ] **Images:** inline and uploaded images are captured (the popup counts them).
- [ ] **Uploaded files:** PDF, text and pasted-text cards are captured; a file that cannot be read stops the copy and is named, and **Skip missing file** marks it as not included.
- [ ] **Cancel:** cancelling a copy stops scrolling at once.

## Paste

- [ ] **Into an open chat:** copy a ChatGPT chat, open a Gemini chat, press **Paste into this chat**; the text appears and the notice lists attached files.
- [ ] **Files over the limit:** a chat with more than 10 files pasted into Gemini attaches the newest ones (with `transcript.md`) and lists the rest.
- [ ] **ChatGPT → ChatGPT, ChatGPT → Claude, ChatGPT → Gemini, Gemini → ChatGPT, Claude → ChatGPT:** text and files arrive; nothing is sent automatically.
- [ ] **Start a new chat in X:** the new tab receives the conversation after it loads (also after signing in).

## Archives

- [ ] **Encrypted export:** saving with a password produces an archive that opens only with that password.
- [ ] **Wrong password:** opening with a wrong password fails cleanly.
- [ ] **Offline reopen:** opening a `.ctxbridge` file restores the conversation without network requests.
- [ ] **Open from a chat tab:** in a Gemini tab, **Open .ctxbridge file**, choose a file, press **Paste into Gemini chat**; the Gemini tab comes back with the conversation.

## Diagnostics

- [ ] **Diagnostics** produces a report without conversation text.
