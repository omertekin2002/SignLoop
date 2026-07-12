export const PRIVACY_CONSENT_EVENT = "signloop:privacy-consent-change";

const PRIVACY_NOTICE_VERSION = "v1";
const sessionAcknowledgements = new Set<string>();

function consentKey(userId?: string | null): string {
  return `signloop:privacy-ack:${PRIVACY_NOTICE_VERSION}:${userId || "anonymous"}`;
}

export function hasPrivacyConsent(userId?: string | null): boolean {
  const key = consentKey(userId);
  if (sessionAcknowledgements.has(key)) return true;
  if (typeof window === "undefined") return false;

  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function acknowledgePrivacyConsent(userId?: string | null): void {
  const key = consentKey(userId);
  sessionAcknowledgements.add(key);

  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Session memory still records the acknowledgement when storage is unavailable.
  }
  window.dispatchEvent(new Event(PRIVACY_CONSENT_EVENT));
}
