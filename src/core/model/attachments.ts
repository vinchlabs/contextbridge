/**
 * File names and types for attachments handed to a target AI or saved to disk.
 * Pure helpers (no DOM), shared by the handoff planner, the popup and the capture side.
 */

function ascii(data: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < data.length; i++) s += String.fromCharCode(data[i]!);
  return s;
}

/** Recognises common image formats by their first bytes; undefined when unsure. */
export function sniffImageMime(data: Uint8Array | null | undefined): string | undefined {
  if (!data || data.length < 4) return undefined;
  if (data[0] === 0x89 && ascii(data, 1, 4) === 'PNG') return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  const head = ascii(data, 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (data.length >= 12 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return 'image/webp';
  if (data.length >= 12 && ascii(data, 4, 8) === 'ftyp') {
    // ISO-BMFF: major brand plus compatible brands, all inside the first box.
    const boxSize = ((data[0]! << 24) >>> 0) + (data[1]! << 16) + (data[2]! << 8) + data[3]!;
    const brands = ascii(data, 8, Math.min(Math.max(boxSize, 16), 64));
    if (/avif|avis/.test(brands)) return 'image/avif';
    if (/heic|heix|hevc|hevx|heim|heis|mif1|msf1/.test(brands)) return 'image/heic';
  }
  return undefined;
}

/** Image types the supported chat sites accept as pictures. */
export function isSendableImageMime(mime: string | undefined): boolean {
  return /^image\/(png|jpe?g|gif|webp|heic|heif)$/i.test(baseMime(mime));
}

export function isImageMime(mime: string | undefined): boolean {
  return /^image\//i.test(baseMime(mime));
}

/** "text/plain; charset=utf-8" -> "text/plain". */
export function baseMime(mime: string | undefined): string {
  return (mime || '').split(';')[0]!.trim().toLowerCase();
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/html': 'html',
  'text/css': 'css',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'application/json': 'json',
  'application/rtf': 'rtf',
  'application/epub+zip': 'epub',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  json: 'application/json',
  ipynb: 'application/x-ipynb+json',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
};

/** Plain-text source and config files: the chat sites read them as text. */
const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h',
  'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'r', 'scala', 'lua', 'pl', 'dart',
  'vue', 'svelte', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'gradle', 'tex', 'bib', 'srt', 'vtt',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'heif', 'bmp', 'svg']);

/** Lower-case extension without the dot; undefined for names like "notes" or "v1.2". */
export function fileExtension(name: string | undefined): string | undefined {
  const n = name || '';
  const dot = n.lastIndexOf('.');
  if (dot <= 0 || dot === n.length - 1) return undefined;
  const ext = n.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) && /[a-z]/.test(ext) ? ext : undefined;
}

export function extensionForMime(mime: string | undefined): string | undefined {
  return EXTENSION_BY_MIME[baseMime(mime)];
}

/** Type from a file name, for blobs stored as application/octet-stream. */
export function mimeForFilename(name: string | undefined): string | undefined {
  const ext = fileExtension(name);
  if (!ext) return undefined;
  if (MIME_BY_EXTENSION[ext]) return MIME_BY_EXTENSION[ext];
  return CODE_EXTENSIONS.has(ext) ? 'text/plain' : undefined;
}

/**
 * True for documents the chat sites read (PDF, text, code, office, e-books). Checked by type
 * and by extension, since captured files often arrive as application/octet-stream.
 */
export function isSendableDocument(mime: string | undefined, name: string | undefined): boolean {
  const m = baseMime(mime);
  if (m === 'application/x-contextbridge') return false;
  if (m.startsWith('text/') || m === 'application/pdf' || m === 'application/json' || m === 'application/xml') return true;
  if (m.startsWith('application/vnd.openxmlformats-officedocument.') || m.startsWith('application/vnd.oasis.opendocument.')) {
    return true;
  }
  if (['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint', 'application/rtf'].includes(m)) {
    return true;
  }
  if (m === 'application/epub+zip' || m === 'application/x-ipynb+json' || m === 'image/svg+xml') return true;
  const ext = fileExtension(name);
  if (!ext) return false;
  return (!!MIME_BY_EXTENSION[ext] && !IMAGE_EXTENSIONS.has(ext)) || CODE_EXTENSIONS.has(ext) || ext === 'svg';
}

/** Makes an image's extension match its real type ("photo.png" holding JPEG bytes -> "photo.jpg"). */
export function withImageExtension(name: string, mime: string | undefined): string {
  const ext = extensionForMime(mime);
  if (!ext || !isImageMime(mime)) return name;
  const current = fileExtension(name);
  if (current && IMAGE_EXTENSIONS.has(current)) {
    if (current === ext || (ext === 'jpg' && current === 'jpeg')) return name;
    return `${name.slice(0, name.length - current.length)}${ext}`;
  }
  return `${name}.${ext}`;
}

/** Safe, readable file name: keeps case and extension, falls back to a short hash. */
export function attachmentFileName(name: string | undefined, sha256: string, mimeType: string | undefined): string {
  const cleaned = (name || '')
    .replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) {
    const ext = extensionForMime(mimeType) || 'bin';
    return `${isImageMime(mimeType) ? 'image' : 'file'}-${sha256.slice(0, 8)}.${ext}`;
  }
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 120 - ext.length) + ext;
}

/** "a.txt" -> "a (2).txt" while the name is taken (case-insensitive). Records the result. */
export function uniqueName(name: string, taken: Set<string>): string {
  const key = (n: string) => n.toLowerCase();
  if (!taken.has(key(name))) {
    taken.add(key(name));
    return name;
  }
  const ext = fileExtension(name);
  // Keep the extension as written ("A.TXT" -> "A (2).TXT").
  const stem = ext ? name.slice(0, name.length - ext.length - 1) : name;
  const suffix = ext ? name.slice(name.length - ext.length - 1) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${suffix}`;
    if (!taken.has(key(candidate))) {
      taken.add(key(candidate));
      return candidate;
    }
  }
}
