/**
 * Typed domain errors for ContextBridge
 */

export class ContextBridgeError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ContextBridgeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AdapterNotDetectedError extends ContextBridgeError {
  constructor(url: string, details?: unknown) {
    super(`No compatible AI chat adapter detected for URL: ${url}`, 'ADAPTER_NOT_DETECTED', details);
    this.name = 'AdapterNotDetectedError';
  }
}

export class ConversationNotFoundError extends ContextBridgeError {
  constructor(platform: string, details?: unknown) {
    super(`No conversation found on ${platform} page`, 'CONVERSATION_NOT_FOUND', details);
    this.name = 'ConversationNotFoundError';
  }
}

export class CaptureIncompleteError extends ContextBridgeError {
  constructor(message: string, details?: unknown) {
    super(message, 'CAPTURE_INCOMPLETE', details);
    this.name = 'CaptureIncompleteError';
  }
}

export class AttachmentFetchError extends ContextBridgeError {
  constructor(url: string, reason: string, details?: unknown) {
    super(`Failed to fetch attachment from ${url}: ${reason}`, 'ATTACHMENT_FETCH_ERROR', details);
    this.name = 'AttachmentFetchError';
  }
}

export class ArchiveCorruptError extends ContextBridgeError {
  constructor(reason: string, details?: unknown) {
    super(`ContextBridge archive is corrupted or malformed: ${reason}`, 'ARCHIVE_CORRUPT', details);
    this.name = 'ArchiveCorruptError';
  }
}

export class UnsupportedArchiveVersionError extends ContextBridgeError {
  constructor(version: number, supported: number = 1) {
    super(
      `Unsupported archive version: ${version}. This version of ContextBridge supports up to version ${supported}.`,
      'UNSUPPORTED_ARCHIVE_VERSION',
      { version, supported }
    );
    this.name = 'UnsupportedArchiveVersionError';
  }
}

export class WrongPasswordError extends ContextBridgeError {
  constructor(details?: unknown) {
    super('Incorrect password or corrupted ciphertext for encrypted archive', 'WRONG_PASSWORD', details);
    this.name = 'WrongPasswordError';
  }
}

export class TargetImportError extends ContextBridgeError {
  constructor(target: string, reason: string, details?: unknown) {
    super(`Failed to inject handoff into ${target}: ${reason}`, 'TARGET_IMPORT_ERROR', details);
    this.name = 'TargetImportError';
  }
}

export class SecurityBoundsExceededError extends ContextBridgeError {
  constructor(resource: string, limit: number, actual: number) {
    super(
      `Security limit exceeded for ${resource}: allowed up to ${limit}, received ${actual}`,
      'SECURITY_BOUNDS_EXCEEDED',
      { resource, limit, actual }
    );
    this.name = 'SecurityBoundsExceededError';
  }
}
