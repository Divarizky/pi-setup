---
name: prompt-authoring
description: Write and review instruction texts for LLMs, including AGENTS.md, SYSTEM.md, SKILL.md, prompt templates, and tool descriptions.
---

# Prompt Authoring

Standard operating procedure for authoring and reviewing instruction files read by LLMs.

## Scope

- Apply rules to instruction files: AGENTS.md, SYSTEM.md, SKILL.md, prompt templates, and extension tool descriptions.
- Out of scope: README files, user-facing documentation, and non-instruction texts.
- Focus review on structural discipline and behavioral control; do not force translation of target texts.

## Normative Language

Align language strictly with the RFC 2119 glossary in repo AGENTS.md (`<system-conventions>`).

| Keyword | Operational meaning | Prohibited alternatives |
|---|---|---|
| MUST / REQUIRED | Absolute requirement | try to, ideally, consider, please make sure |
| MUST NOT / NEVER | Absolute prohibition | try not to, avoid if possible |
| SHOULD / RECOMMENDED | Valid reasons may exist to ignore, but full implications must be understood | should probably, it is recommended to consider |
| AVOID | Mandatory operational alias for SHOULD NOT | preferably avoid, do not try to |
| MAY / OPTIONAL | Truly optional behavior | might want to |

- State rules as imperative requirements.
- NEVER use weak modals ("try to", "ideally", "consider", "please") for mandatory constraints.
- Use `NEVER` and `AVOID` as strict operational aliases for `MUST NOT` and `SHOULD NOT`.

## Density and Phrasing

Maximize instructional density. Remove conversational padding, polite preambles, and speculative rationales that do not change runtime behavior.

| Bad | Good |
|---|---|
| Please make sure to understand the user request before you begin to act. | Understand the request before acting. |
| You should try to make the smallest valid change and only touch relevant files. | Make the smallest valid change; modify ONLY files relevant to the instruction. |
| Avoid tautological tests like expect(true).toBe(true) because they do not help quality. | BANNED tautology: expect(true).toBe(true), bare not.toThrow(), non-empty string checks. |

- State one instruction per bullet.
- Cut polite filler ("please", "thank you", "feel free to").
- Remove explanations that explain why without altering what the agent executes.

## Critical Positioning

LLM attention fades across long contexts. Use `<critical>` blocks to sandwich vital constraints at the top and bottom of long files.

- MUST place `<critical>` blocks at the top and bottom of instruction documents longer than 60 lines.
- MUST NOT use `<critical>` blocks in short files (60 lines or fewer).
- Keep content in `<critical>` blocks minimal: 2 to 5 non-negotiable invariants only.
- Mirror or reinforce core completion and verification criteria across both blocks.

## Anti-Patterns

| Anti-Pattern | Operational Flaw | Remediation |
|---|---|---|
| Polite padding | Wastes context tokens and weakens imperative force | Strip conversational preambles and courtesies |
| Tips or bribes | Ineffective and non-deterministic | Define strict criteria and acceptance contracts |
| Explicit CoT on reasoning models | Conflicts with internal reasoning mechanisms | Constrain input and output contract instead |
| Self-critique without external tools | Produces sycophantic hallucinated confirmations | Enforce verification via runtime tools or tests |
| Burying key rules in mid-document | Context loss due to attention drop in middle text | Place invariants in `<critical>` or top section |
| Long prohibition lists without fallback | Induces refusal loops or paralysis | Pair every NEVER with a valid alternative action |
| Contrastive negative examples | Priming triggers prohibited behavior in completion | Show only direct positive pattern or clear diff |
| Instructing compiler or runtime guarantees | Redundant prompt bloat for schema-enforced rules | Rely on code-level enforcement and schema gates |

## Tool Description Authoring

- Document ONLY when and why to invoke the tool; omit internal implementation mechanics.
- Provide between 3 and 8 clear usage examples.
- MUST place the canonical invocation syntax at the end of the description.

## Review Checklist

Answer each question with YES or NO during prompt review:

1. Normative rigor: Does the text use RFC 2119 keywords without weak phrases like "try to" or "consider"?
2. Instructional density: Is every bullet a single actionable command without polite padding or no-op rationale?
3. Critical framing: Does a file longer than 60 lines contain top and bottom `<critical>` blocks, while short files omit them?
4. Reasoning compatibility: Does the prompt avoid forcing explicit chain-of-thought on reasoning models?
5. External verification: Are completion claims gated by actual tool or test execution rather than pure self-reflection?
6. Actionable negatives: Does every prohibited behavior provide a concrete approved path or fallback?
7. Tool description boundary: Do tool descriptions focus strictly on trigger conditions without leaking implementation details?
