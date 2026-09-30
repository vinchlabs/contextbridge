/**
 * String and filename sanitization utilities
 */

export function sanitizeFilename(name: string, fallback: string = 'conversation'): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();

  return sanitized.length > 0 ? sanitized.slice(0, 60) : fallback;
}

export function formatDateForFilename(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
