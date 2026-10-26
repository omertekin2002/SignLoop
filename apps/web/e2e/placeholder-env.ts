// Placeholder configuration for the end-to-end smoke server. Nothing here is a real credential:
// the smoke never signs in, and AuthKit builds its authorization URL locally from these values.
export const E2E_PORT = 3100;
export const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_WORKOS_CLIENT_ID = "client_e2e_placeholder";
export const E2E_REDIRECT_URI = `${E2E_ORIGIN}/callback`;

export const E2E_SERVER_ENV = {
  WORKOS_API_KEY: "sk_test_e2e_placeholder",
  WORKOS_CLIENT_ID: E2E_WORKOS_CLIENT_ID,
  // AuthKit requires at least 32 characters.
  WORKOS_COOKIE_PASSWORD: "e2e-placeholder-cookie-password-not-a-secret",
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: E2E_REDIRECT_URI,
  NEXT_TELEMETRY_DISABLED: "1",
};
