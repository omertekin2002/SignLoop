import { config } from "zod";

// Zod compiles object parsers with `new Function` where eval is allowed, and probes for that with a
// throwaway `new Function("")` when it builds its first object schema. The Content Security Policy
// (lib/content-security-policy.js) allows no eval in production, so the probe raised a violation
// report on every page, and would just fail once the policy is enforced. `jitless` skips the probe
// and the compiled parsers; parsing is unchanged. This file runs before the app's own modules,
// which build schemas when they are imported.
config({ jitless: true });
