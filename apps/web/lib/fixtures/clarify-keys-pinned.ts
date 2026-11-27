import type { ClarifyChecklistKeys } from "../clarify-keys";

// The keys of `storedAnalysis()` (./clarify-analysis.ts). The Node and the browser-environment
// tests both check them, so the two runtimes cannot disagree. A Python FNV-1a over the same JSON
// gives the same hashes. Change them only together with CLARIFY_KEY_VERSION: stored decisions
// carry these keys.
export const PINNED_KEYS: ClarifyChecklistKeys = {
  unverified: [
    {
      key: "v1:unverified:notice:bff6c4873b00f123",
      ambiguous: false,
    },
    {
      key: "v1:unverified:payment:4943fc4e1fc18eb8",
      ambiguous: false,
    },
    {
      key: "v1:unverified:fee:16847ed8d1746c57",
      ambiguous: false,
    },
    {
      key: "v1:unverified:fee:3e213a4c25c5e54c",
      ambiguous: false,
    },
    {
      key: "v1:unverified:key-date:4cbd2a62244db149",
      ambiguous: false,
    },
  ],
  unstated: [
    {
      key: "v1:unstated:term",
      ambiguous: false,
    },
  ],
  findings: [
    {
      key: "v1:finding:03b17d4720836c0f",
      ambiguous: false,
    },
    {
      key: "v1:finding:9f29ae89746cbc6c",
      ambiguous: false,
    },
    {
      key: "v1:finding:88d641c6cbffd9c8",
      ambiguous: false,
    },
  ],
  questions: [
    {
      key: "v1:question:b985df5055d27f9a",
      ambiguous: false,
    },
    {
      key: "v1:question:315cb8518d16a981",
      ambiguous: false,
    },
  ],
};
