# Guardrails (Signs)

> Lessons learned from failures. Read before acting.

## Core Signs

### Sign: Read Before Writing
- **Trigger**: Before modifying any file
- **Instruction**: Read the file first
- **Added after**: Core principle

### Sign: Test Before Commit
- **Trigger**: Before committing changes
- **Instruction**: Run required tests and verify outputs
- **Added after**: Core principle

---

## Learned Signs


### Sign: Expect Lint Warnings Baseline
- **Trigger**: When running `npm run lint` in this repo
- **Instruction**: Note existing warnings cause failure; only fix if the story requires lint cleanup.
- **Added after**: Iteration 1 - lint fails with max-warnings 0 due to existing warnings
- **Example**: apps/web has unused vars and explicit any warnings that trigger lint failure
