/**
 * Content-script side of MAIN-world hook installation.
 * Asks the background script to run an allow-listed installer (`installResourceCardProbeHooks`
 * or `installFileCaptureHooks`) in the page's MAIN world via scripting.executeScript, which is
 * not subject to the page CSP. Never throws.
 */

import type { MainWorldProbeInstallArgs } from './probe-main-world';
import type { FileCaptureInstallArgs } from './file-capture-main-world';

export const PROBE_INSTALL_MESSAGE_TYPE = 'PROBE_INSTALL_MAIN_WORLD' as const;

async function requestInstall(
  hook: 'resource-card-probe' | 'file-capture',
  args: MainWorldProbeInstallArgs | FileCaptureInstallArgs
): Promise<{ ok: boolean; error?: string }> {
  const runtime = typeof browser !== 'undefined' ? browser?.runtime : undefined;
  if (!runtime?.sendMessage) {
    return { ok: false, error: 'extension_runtime_unavailable' };
  }
  try {
    const res = (await runtime.sendMessage({ type: PROBE_INSTALL_MESSAGE_TYPE, hook, args })) as
      | { ok?: boolean; error?: string }
      | undefined;
    if (res && typeof res.ok === 'boolean') {
      return { ok: res.ok, error: res.error };
    }
    return { ok: false, error: 'no_response_from_background' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function requestMainWorldProbeInstall(args: MainWorldProbeInstallArgs): Promise<{ ok: boolean; error?: string }> {
  return requestInstall('resource-card-probe', args);
}

export function requestFileCaptureInstall(args: FileCaptureInstallArgs): Promise<{ ok: boolean; error?: string }> {
  return requestInstall('file-capture', args);
}
