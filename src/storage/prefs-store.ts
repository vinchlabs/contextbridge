/**
 * Small persisted UI preferences (no conversation data).
 */

export interface UiPrefs {
  /** Copy files and images along with the text, and attach them when pasting. */
  includeAttachments: boolean;
}

const PREFS_KEY = 'cbUiPrefs';
const DEFAULT_PREFS: UiPrefs = { includeAttachments: true };

export async function loadPrefs(): Promise<UiPrefs> {
  try {
    if (typeof browser === 'undefined' || !browser.storage?.local) return { ...DEFAULT_PREFS };
    const got = (await browser.storage.local.get(PREFS_KEY)) as Record<string, Partial<UiPrefs> | undefined>;
    const stored = got?.[PREFS_KEY];
    return {
      includeAttachments:
        typeof stored?.includeAttachments === 'boolean' ? stored.includeAttachments : DEFAULT_PREFS.includeAttachments,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function savePrefs(prefs: UiPrefs): Promise<void> {
  try {
    if (typeof browser === 'undefined' || !browser.storage?.local) return;
    await browser.storage.local.set({ [PREFS_KEY]: prefs });
  } catch {
    // Preferences are best effort.
  }
}
