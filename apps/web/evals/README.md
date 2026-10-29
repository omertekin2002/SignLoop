# Contract analysis evaluations

Measures how well contract analysis finds risky clauses, quotes them verifiably, and abstains when the contract text that was sent does not establish a fact. Cases are synthetic and hand-written.

## Tiers

**Deterministic replay (this tier).** Runs with `bun run test`, so it runs in CI. It makes no provider calls and costs nothing. Each case's hand-written ideal model output (`oracle/`) is replayed through the production path: `buildAnalysisPrompt`, the OpenAI SDK client, provider fallback, JSON salvage and validation in `analyzeText`, then `finalizeAnalysisResult`, the same post-processing the analyze route stores. Every oracle must reach its documented ideal. Seven deliberately bad responses (`oracle/perturbations/`) must each move exactly the metrics they declare. This tier tests the pipeline and the scorers, not a model.

**Live recording (later, not built).** It will run only when `SIGNLOOP_EVAL_LIVE=1` is set, with hard caps on calls and cost, from a `workflow_dispatch`-only GitHub workflow. It will record real provider exchanges in the replay format, with `expect.fingerprint` set (see `transport.ts`), so recordings replay deterministically and are rejected once the prompt or request changes.

## Network isolation

`bun run` loads `apps/web/.env.local`, which may contain real keys. The harness therefore:

- points `PRIMARY_LLM_BASE_URL` at `https://replay.invalid/v1`,
- clears `OPENROUTER_API_KEY`, which disables the fallback chain, and
- replaces `fetch` with a replay transport that never performs I/O and refuses any request other than the next recorded response.

A refused or unused recording fails the run rather than being scored. ESLint blocks imports of database and storage modules under `evals/`, including dynamic `import()`.

## Layout

| Path                                                   | Contents                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `cases/*.json`                                         | Gold annotations, validated by `case-schema.ts`.                                                                                      |
| `contracts/*.txt`                                      | Contract and project-context text. Git stores them byte-exact (`-text`) because offsets and SHA-256 revisions depend on line endings. |
| `oracle/*.json`                                        | One ideal model output per case. `ideal` lists metrics where even the ideal answer falls short, with the value production yields.     |
| `oracle/perturbations/*.json`                          | JSON-pointer patches to an oracle, with the exact metrics each may move.                                                              |
| `taxonomy.ts`                                          | Clause categories and the aliases that map free-text flag types onto them.                                                            |
| `dataset.ts`, `transport.ts`, `harness.ts`, `score.ts` | Loading, replay, pipeline execution, and pure scorers.                                                                                |

Each gold span must occur exactly once in the contract, inside one segment production sends: `full`, or beyond 15,000 code points `head`, `tail`, or a selected middle passage `middle-1` to `middle-4` (`contractAnalysisSegments` in `lib/source-citations.ts`). A declared `segment` must name that segment. Spans marked `"segment": "omitted"` must lie wholly in the unsent middle, outside every selected passage, and cannot be required.

## Metrics

- **Clause recall** (headline): a required clause is found when at least half of a verified citation's characters lie inside its gold span. Also reported per category, as label recall (some flag type names the category), and as character-level span precision.
- **Quote accuracy**: the share of flags with evidence and the share verified by production rules. Failures get an evaluation-only diagnosis, such as wrong segment, ambiguous, whitespace/typography/Unicode drift, quoted context or prompt, near miss, or fabricated. Production matching is never loosened.
- **Abstention**: each gold field is scored as correct, wrong, false abstention, correct abstention, or fabricated. Placeholders such as "Not specified" count as abstaining. Notice and renewal periods are compared as (number, unit). `auto_renew` has a 3×3 confusion table. Answering `false` when the gold value is null is the critical error.
- **Negative controls**: flags naming a category listed in `absent`, high-severity flags (7 or above) or a HIGH badge on `benign` contracts, and regional comparisons the model proposes, since no case confirms a jurisdiction. `comparisons.withheld` separately requires the stored report to keep none of them and to carry the server's `comparisons_withheld` flag.
- **Jurisdiction proposal**: for cases with `governing_law` gold, the stored `proposed_jurisdiction` is correct when its verified citation lies mostly inside the gold clause and names the gold jurisdiction. `null` gold means the contract has no governing-law clause, so the ideal answer proposes none. `negatives.unverified_jurisdiction` counts proposals production dropped because their quotation did not verify, such as an invented clause.
- **Key dates and parties**: recall of ISO dates, dates outside the gold list, and alias-matched parties.
- **Parse path**: strict, partial, normalized, rejected (validation), or failed (provider), as far as it is observable without production hooks. Output that needed syntax salvage is reported as unobserved.

## Adding a case

1. Write the contract under `contracts/` using invented parties, RFC 2606 example domains, and 555-0100 to 555-0199 telephone numbers. The privacy test rejects other emails and phone numbers, and checksum-valid card numbers, IBANs, and SSN-shaped numbers.
2. Add `cases/<id>.json` with spans copied exactly from the contract.
3. Add `oracle/<id>.json` with the ideal output (with no confirmed jurisdiction, `normal_in_region` stays empty; `proposed_jurisdiction` quotes the governing-law clause, or is null without one), and run `bun run test evals` from `apps/web`.

Category names follow [CUAD](https://www.atticusprojectai.org/cuad) (CC BY 4.0) and UNFAIR-ToS (Lippi et al., 2019, distributed in LexGLUE). Only label names are borrowed; no dataset text is included.
