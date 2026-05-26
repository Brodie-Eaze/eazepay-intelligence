/**
 * Auth-surface primitives.
 *
 * Shared by every unauthenticated page (`/login`, `/accept-invitation`,
 * and any future MFA / password-reset surface). Keeps the brand
 * treatment, focus rings, trust messaging, and form geometry locked
 * across surfaces — a lender sees the same product from sign-in
 * through to overview.
 *
 * None of these primitives know anything about the auth API; they are
 * pure UI. Pages own the data fetch, validation, and submission.
 */
export { AuthCard } from './AuthCard';
export { AuthError } from './AuthError';
export { AuthField, AUTH_INPUT_CLASS, AUTH_PRIMARY_BUTTON_CLASS } from './AuthField';
export { BrandMark } from './BrandMark';
export { MfaCodeInput } from './MfaCodeInput';
export { TrustLine } from './TrustLine';
