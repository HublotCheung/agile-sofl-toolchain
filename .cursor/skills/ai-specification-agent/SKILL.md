---
name: ai-specification-agent
description: Implement or extend the Agile-SOFL Studio Specification Agent (ChatECNU, skills, clarification cards, patch preview). Use when working on agent sessions, LLM tools, ChatECNU, Informal or Hybrid AI UX.
---

# AI Specification Agent

API key stays in the Electron **main** process. Configure profiles in **Settings** (base URL + API key + model). `.env` (`ECNU_API_KEY`, default model `ecnu-max`) is the fallback seed.

Base URL (ChatECNU default): `https://chat.ecnu.edu.cn/open/api/v1`

Reuse this loop for Informal and Hybrid. Do not create a second agent runtime. New sessions pick Informal/Hybrid read+write (defaults: Informal + Hybrid full access). Hybrid generation injects `hybrid-generation` and Informal-read / Hybrid-write.

## Loop

User NL → skill prompt + spec digest → ChatECNU tools (filtered by session permissions) → UI cards → user confirms **or auto-write** → patch apply via the global undo stack → **the same turn continues** with the tool result.

Informal tools: `ask_clarification`, `read_specification` (`view=inventory|source`), `propose_changes`, `propose_source_edit`, `review_specification`.
Hybrid tools: `read_hybrid_specification` (`view=inventory|source`), `read_refinement_state` (`view=summary|tree|log`), `propose_hybrid_changes`, `propose_refinement_step`, `propose_source_edit`, `review_hybrid`.

`propose_changes` is Informal-only. `propose_hybrid_changes` uses inventory ids (`mod:`, `proc:`, `scn:`, `gui:`, `type:`, `var:`, `inv:`). Prefer updating an existing id over adding a duplicate. Write `pre`/`post`, never `FSF :`. Enumerations use `{<Tag>}`. **CRUD is the default.** Do not dump multi-module SOFL through CRUD. After each applied write, call `read_*` and keep patching until the inventory is correct. The last assistant message is a task summary.

The product journey is Informal → Hybrid+GUI → three-line refinement (process atomicity + data discharge + operational grain). The system prompt includes a refinement digest. After Hybrid/GUI stages, the agent **guides** the next refinement slice with `ask_clarification`; it does not auto-refine the whole tree. Empty modules and stub processes are gaps.

Operational grain is not a CRUD catalog. `ask_clarification` may only offer variations already extracted in the digest (plus `name-claim`). Close them with `ClassifyGrain` or `ResolveVariation`. Rewriting pre/post does not reduce `grainAmbiguity`. `DeclareAtomic` requires the formal gates and grain closure.

`propose_source_edit` is the escape hatch: unique `replace` / `append` / `replace-document` against numbered source (`read_* view=source`). Use it when CRUD fails, inventory is empty/out of sync, or an uncovered parser/id issue would otherwise loop. After two CRUD failures, the loop **blocks** the same/repeated CRUD and requires a source edit. Source edits still go through Apply/auto-write and `useHistoryStore`. Informal atoms rewritten only via source edit still need `FormalizePredicate` or process ambiguity will not drop.

Writes are kept even when the result is incomplete or not yet legal ASFL. Missing or partial Informal↔Hybrid traceLinks on a hybrid proposal is a warning only — the patch is still offered and can be applied while links are fixed later. Studio auto-repairs a few surface forms (trailing prime, `^`, `!=`, `iff`), then saves the text. Parser and provenance problems come back as **warnings and diagnostics** on the tool result (`action: applied`, `ok: true`). Fix them with a follow-up patch. Do not treat lint as a rejected write. Hard tool failures are only: empty patches, no open document tab, concurrent edit while saving, permission off, malformed tool JSON, or GUI sandbox safety violations. Everything else (traceLinks, patch shape lint, unrepaired ASFL surface, repeat CRUD fingerprint, refinement-step validation, zero-change apply) is **warnings** on the proposal or `action: applied` with `warnings` / `diagnostics` — never `ok: false` on apply for lint alone.

## UX

Clarification: option chips + optional custom input. A typed custom answer is always returned to the model as `custom`, including single-choice and when an option is also selected. Checking or unchecking an already answered option asks whether to fork a new session from that question or overwrite the current thread. After fork/overwrite, leave the clarification pending until the user confirms — do not auto-resume the LLM turn.
Message bubbles: selectable text, with Copy and Fork actions.
Changes: `Patch → Preview → Apply | Reject`. Apply/Reject is only a tool result — **resume the agent**. Send-bar: while the agent is running the send button becomes a red **Stop** control that aborts the in-flight turn. Permission: **Ask me each time** (default) vs **Allow auto-write** (persisted `studio-agent-write-mode`).
Sessions: `<project>/.agile-sofl/agent/sessions/`.
Informal document metadata: `<project>/.agile-sofl/informal-meta.json`.

## GUI prototype

The prototype runs in a sandboxed iframe (`allow-scripts` only). Inline `<script type="text/as-logic">` and `onclick` / `oninput` / `onchange` may compute or animate inside that frame. They must not be able to reload or rewrite the Studio window. Keep one `propose_gui_changes` call to a single screen. Truncated or trailing-junk tool JSON is repaired; a parse failure must not become an empty patch that blocks the next different write.

## Don't

- Stream raw markdown or raw SOFL into the document from chat text (writes must go through tools).
- Send the API key to the renderer.
- Dump the entire chat history into every LLM call (keep a recent window + spec digest).
- Bypass `useHistoryStore` when applying Informal or Hybrid patches.
- Retry the same failing CRUD patch; switch to `propose_source_edit` instead.
