'use client';

/**
 * Third-party Tawk.to is not part of the public site.
 * This hook never injects a script, frame, or global chat API.
 * Necessary human contact is a first-party path and does not read the legacy chat flag.
 */
export const tawkConfigured = false;

export function useTawk(locale: string): { enabled: false; ready: false; open: () => false } {
  void locale;
  return {
    enabled: false,
    ready: false,
    open: () => false,
  };
}
