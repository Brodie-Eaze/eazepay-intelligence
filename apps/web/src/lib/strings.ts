/**
 * Centralised UI strings — only the genuinely shared ones.
 *
 * Rule of three: if a literal appears in 3+ places, lift it here.
 * One-offs stay inline at the call site — over-centralising button
 * labels makes the code harder to read, not easier.
 *
 * Voice rules live in `voice.md` next to this file.
 */

/** Generic action labels — buttons used across more than 2 surfaces. */
export const ACTIONS = {
  cancel: 'Cancel',
  confirm: 'Confirm',
  save: 'Save',
  delete: 'Delete',
  revoke: 'Revoke',
  copy: 'Copy',
  dismiss: 'Dismiss',
  retry: 'Retry',
  signIn: 'Sign in',
  signOut: 'Sign out',
} as const;

/** In-flight button labels — present continuous + ellipsis. */
export const BUSY = {
  loading: 'Loading…',
  saving: 'Saving…',
  sending: 'Sending…',
  queueing: 'Queueing…',
  creating: 'Creating…',
  verifying: 'Verifying…',
  signingIn: 'Signing in…',
  revoking: 'Revoking…',
} as const;

/** Standard short messages — used in empty / error states. */
export const EMPTY = {
  noData: 'No data.',
  noResults: 'No results.',
} as const;

export const ERRORS = {
  /** Generic load failure. Prefer endpoint-specific copy when you can. */
  loadFailed: 'Couldn’t load this view. Retry.',
  /** Generic action failure when the server didn't supply a message. */
  actionFailed: 'Action failed. Try again.',
} as const;
