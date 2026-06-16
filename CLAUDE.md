# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## Project: MemeDay
Architecture reference: see `docs/ARCHITECTURE.md`. Read it before changing data flow, auth, storage, or on-chain behavior. Bags.fm is mocked: no real mainnet calls without explicit approval.

Auth (Cognito is the only identity system):
- `userId` IS the Cognito `sub`. Do not generate your own user IDs.
- Sign-up needs email OR wallet alone (either is valid); link the other later. Never require both.
- Wallet login is a Cognito custom-auth challenge (sign nonce: Cognito verifies: JWT session). Do not build a separate or parallel wallet/JWT session system alongside Cognito.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## 5\. Git Workflow
**Never commit directly to `main`. Always work on a branch.**
-   Never commit changes without user permission
-   Create a feature branch before starting any work: `git checkout -b feat/<short-description>`
-   `main` is the stable branch. It must stay in a working state at all times.
-   A branch is only merged to `main` when all tests pass. Do not propose or execute a merge with failing tests.
-   Tests cover existing functionality and must be updated when new functionality is added. If a change breaks an existing test, fix the test (or the code) before merging — do not delete or skip tests to make CI green.
-   If you are unsure whether a change will break existing tests, run them before proceeding.

---
## Effort Level Check
Be cognizant of token usage. Be concise and advise me when to start a new chat or session.

Before starting work, assess whether the current model and effort level is sufficient.

Recommend High, XHigh, or Max effort for:
* Difficult debugging or root-cause analysis
* Security reviews
* Architecture/design decisions
* Large refactors
* Multi-file investigations
* Complex research
If a higher effort level is warranted, stop and tell the user: "This task would benefit from [High/XHigh/Max] effort. Please increase the effort level and rerun the request." Do not proceed until the user confirms.

## Model Routing Guidance
- Simple lookups, grep, file reads → suggest Haiku
- Standard coding, refactoring → Sonnet (default)
- Architecture decisions, complex debugging → suggest Opus

## Dependency awareness
- Before implementing any change that touches an external library, check which version and variant is actually installed in the active virtualenv: `pip show <package>` or `pip list | grep <package>`.
- Never assume which library variant is in use based on the task description alone. Example: Google auth has two incompatible libraries (google-auth vs oauth2client) with different APIs. HTTP clients (requests vs httpx vs urllib3), database drivers (psycopg2 vs psycopg3), and async frameworks have similar incompatibility traps.
- If multiple variants could satisfy a requirement, check the actual installed package before writing implementation code.

## Honesty constraints
- Never fabricate specific values (timestamps, addresses, line numbers, config values, API responses) without a cited source.
- If an exact value is unknown, say "I don't know — check [source]" rather than inferring a plausible-looking value.
- This applies even when a fabricated value would be structurally correct (e.g., a correctly formatted ISO timestamp that has the wrong time).
- Before claiming a function, class, import, or config key exists, verify it by reading the file or running grep. Never fabricate symbols.
- If you cannot verify something, say "I haven't verified this" and do not write code that depends on the unverified claim.
- "I don't know" and "I need to check first" are valid and preferred over a confident guess.
- Do not claim tests or builds passed unless you actually ran the command in this session.

## Secret Handling
Never ask the user to paste, share, or display secret values including:
private keys, API keys, API secrets, passphrases, passwords, or any credentials.
If output contains secrets, instruct the user to copy them directly to .env
without sharing them in chat.
