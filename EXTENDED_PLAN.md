# Tab v2: general, local, vision-aware next-action autocomplete

## Context

Tab today is a hackathon proof of concept (branch `more-work`, identical to `main`). It works in three places, each wired by hand:
- **Chrome** through CDP plus an injected script (`web/src/inject.js`).
- **Terminal**, read-only, through `shell/.../TerminalReader.swift`.
- **Calendar**, an allow-listed app (`NativeApp.swift`, `nativeApps = ["com.apple.iCal"]`) running one hardcoded 7-step sequence (`brain/src/calendar.ts`).

Predictions come from the pattern engine (`brain/src/pattern.ts`) or from **Jev**, TypeSafe's remote text-only model that picks one of a list of options. Jev is slow on bad networks (p90 700 ms, up to 5 s), can't write text, and needs regexes and confidence boosts tuned per site (`candidates.ts` `VALUE_RES`, `model.ts` `BUY`/`SUBMIT`).

**Goal:** one general system that works in any app with no per-app code:
1. Read any app through the Accessibility (AX) tree, Chrome included, with vision where AX gives nothing.
2. Keep a smart local memory of everything the user does.
3. Predict with fast local tiers: pattern, then memory, then a small local LLM. Cloud is opt-in, and only for long free text.
4. Run any action through generic AX/CGEvent calls.

Latency is a hard requirement.

**Decisions made:**
- Target hardware is M-series Macs with 16 GB or more (dev Mac: M2, 16 GB, Ollama installed).
- Local-first, with an opt-in cloud model only for long text.
- Chrome is read through AX like every other app. CDP becomes optional enrichment, and payments become an optional plugin off the core path.
- Always-on local recording, with an app denylist, never recording secure fields.

## Architecture

```
TabShell (Swift)                      Brain (TS, hub :7800)                  Local models
 ├─ AXSensor: any frontmost app  ─┐    ├─ Predictor ladder                    llama-server (llama.cpp)
 ├─ ActionObserver: clicks/keys ──┼──▶ │   T0 pattern  (<5 ms)                 ├─ text LLM ~1–2B Q4
 │   → resolved to AX element     │    │   T1 memory   (<25 ms)                ├─ embedder ~300M
 ├─ VisionSensor (on demand):     │    │   T2 local LLM (≤350 ms p50)          └─ VLM ~0.5–1.6B (on demand)
 │   Vision OCR + crops           │    │   T3 vision / opt-in cloud (async)
 ├─ Actuator: AXPress / CGEvent / │    ├─ Memory (SQLite + vectors, ~/.tab/memory.db)
 │   paste / keys                 │◀── ├─ Sequence runner (existing)
 └─ Overlay/HUD (existing)        │    └─ Consolidator (idle-time jobs)
web/ (CDP) optional enrichment ───┘
```

The shell becomes the universal sensor and actuator. The brain stays in TypeScript and keeps the hub, the sequence runner, the pattern engine, the tests and replay. The `Decider` interface in `brain/src/model.ts` is where Jev comes out and the local model goes in.

## 1. Universal perception (shell)

**Generalize `NativeApp.swift` into `AXSensor.swift`.**
- Remove the allow-list. Read the focused window of whatever app is frontmost.
- Use `AXObserver` notifications (focused element changed, value changed, window created, layout changed, selected text changed) to trigger snapshots, with a 400 ms poll only as a fallback.
- Fetch attributes in batches with `AXUIElementCopyMultipleAttributeValues`. This is the main speed lever.
- Walk breadth-first from the focused element outward, then the rest of the window. Prune offscreen subtrees. Cap at about 200 elements. Keep the 0.25 s messaging timeout. **Budget: snapshot ≤ 50 ms p50.**
- Turn on the AX tree where apps hide it: set `AXManualAccessibility` on Electron apps (Slack, VS Code, Notion) and `AXEnhancedUserInterface` on Chrome. The page URL comes from the `AXWebArea`'s `AXURL`.
- Keep `TerminalReader`'s AX path. It becomes just one app among the rest.

**Extend `El` in `protocol/types.ts` and `Protocol.swift`, additively:**
- Roles: `cell`, `row`, `menuitem`, `tab`, `slider`, `image`, `canvas`.
- New fields:
  - `focused`, `placeholder`, `help`, `axId`
  - `section`: the nearest labelled ancestor group or heading, e.g. "Shipping address". This matters most for retrieval.
  - `grid: {row, col}`: from `AXRowIndexRange`/`AXColumnIndexRange`/`AXIndex`, or a name-box address like "B7" when one is visible.
  - `caret`: the rect from `AXBoundsForRange` of the selected range, used to place inline ghost text.
- `ScreenState.source` gains `"ax"`. A stable descriptor path replaces the CSS path: a chain of (role, label/axId, sibling index).

**`ActionObserver`.** `InputTap.swift` already sees every key and click, but today it only reports a bare `input{kind}`. From now on:
- Clicks are resolved with `AXUIElementCopyElementAtPosition`.
- A typing burst is turned into one `type` action: the field's AX value before and after, committed on blur, Enter, Tab or a 1.2 s pause.
- Shortcuts become `key` actions (e.g. cmd+shift+T).
- The result is the protocol's `UserEvent`, now with `source: "native"`, so every app reports actions in the same shape web already uses.
- **Privacy at the source:** drop `AXSecureTextField`, anything while `IsSecureEventInputEnabled()`, and denylisted apps (password managers, Keychain Access, and a user list in `~/.tab/config.json`).

**`VisionSensor` (on demand, only when AX is poor).**
- Trigger: few labelled elements in the focused window, or nothing in AX under the cursor or focus (canvas apps, games, some Electron apps).
- ScreenCaptureKit takes a crop of the window around the focus or cursor. Apple Vision `VNRecognizeTextRequest` runs on-device in about 50–150 ms.
- The OCR text boxes become pseudo-`El`s (role text or button, with real rects), so the rest of the pipeline is unchanged.
- **Icon labelling cache:** an AX button with no label gets its crop captioned once by the small VLM, cached by perceptual hash. This gives generic labels to icon-only toolbars with no cost per step.
- A full VLM pass over the screen runs only for canvas windows, asynchronously, and never blocks a ghost.
- TabShell needs its own Screen Recording grant.

## 2. Generic execution (shell)

Extend `NativeApp.exec` into `Actuator.swift`, used for every app, with no `nativeApps` gate:
- **click:** `AXPress` if the element supports it. Otherwise a CGEvent click at the center of its rect.
- **type:** focus the element, then type unicode keystrokes (already written). Text over about 40 characters goes in by paste: save the clipboard, paste, restore it. Wait until the AX value matches (pattern already in `exec`). A popup uses `choose()`.
- **key:** a full key map with modifiers. Today only Return, Escape and Tab are handled.
- **scroll, menu:** `AXShowMenu`, and menu bar items reached by their AX path.
- **Target lookup:** match the descriptor path first. If that fails, use fuzzy matching on role, label and section, then on the rect.

Routing changes: every action goes to the shell unless `app` is Chrome and the CDP enrichment is connected. The `CHROME` routing in `brain/src/state.ts` and `brain.ts` becomes "prefer web if present".

## 3. Action memory (the storage layer)

**The rule:** store meaning, not pixels; store each thing once; store where a value came from, not just the literal; and compact over time.

Everything lives in one SQLite file, `~/.tab/memory.db`, opened in WAL mode with `better-sqlite3` and `sqlite-vec`. Vectors are also kept in memory for brute-force kNN, which is fine up to about 100k items.

### 3.1 Raw layer, compacted at write time

- **`snapshots`: content-addressed screen states.**
  - A state is compacted (the `El` list without rects or ids) and hashed. Each distinct screen is stored once, zstd-compressed.
  - Most screens repeat, so this deduplicates heavily. Today's 206 MB of logs over 4 days are almost all repeated states.
  - Each element also gets a hash, so diffs between snapshots are cheap.
- **`steps`: one row per action** by the user or by Tab. Columns:
  - `ts`, `app`, `window`, `url/doc`, `op`
  - `target_sig`: role + normalized label + section + axId + grid
  - `value`, `before_snap`, `after_snap`, `episode_id`
  - `by`: user, tab-accepted, or tab-dismissed (accepts and dismissals double as training labels)
- **`crops`:** small target-element images, only for vision-labelled elements. Content-addressed, with a 30-day TTL. Never full screenshots.

### 3.2 Derived layer: this is what prediction reads

1. **Value provenance.** At write time, every typed value is traced to its source:
   - copied from an element on screen, or from another recent screen in any app (the cross-app version of `pattern.ts`'s `prov`);
   - a known fact (3.2.2);
   - an arithmetic or date sequence from earlier values (renumbering rows: n+1);
   - a transform such as case, trim or a date format;
   - or literal.

   The step stores the derivation, e.g. `value = fact:email` or `value = prev+1`, alongside the literal. This is what lets a recorded step replay correctly in a new context.
2. **Field facts (forms are retrieval).**
   - Key = an embedding of (field label + placeholder + section + window title + app/domain). Value = the typed value, with count, last-used and the source contexts.
   - Near-duplicate keys merge, so "Employer", "Company" and "Previous employer" collapse into one fact cluster.
   - Lookup: on focus of an empty text field, take the top match. Show it as gray ghost text if similarity × consistency is above the threshold.
3. **Action templates and a habit graph.**
   - Each step is abstracted into a template, with variables lifted out: (app, window kind, op, role, normalized label), and values, ids and row indices replaced by slots. This is similar to Drain log-template mining.
   - Transitions between templates go into an n-gram table with backoff (keys: last 1–3 templates + app), holding counts with exponential recency decay.
   - Lookup is a hash read, well under 1 ms.
   - Typical prediction: "after `Click Send` in Mail you usually `Click Archive`."
4. **Workflows.** Repeated template subsequences are mined into parameterized workflows (steps + parameter provenance). This generalizes the current `~/.tab/workflows.json` and its `Workflow`/`unitFor` into the database; the existing teach-once and recall behaviour carries over.
5. **Situation index.**
   - Each step has a situation: a short text of app, window, focused element and its neighbours, and the last 3 actions. It is embedded and stored.
   - kNN over situations returns past moments that look like now, plus what the user did next. These feed T1 candidates and T2 few-shot examples.
6. **Episodes.**
   - The stream is cut into tasks at app or window switches and idle gaps over 2 minutes.
   - At idle time, the local LLM writes a one-line summary of each episode, e.g. "Filled job application at acme.com".
   - Summaries are embedded for search ("the form I filled last week") and serve as long-range context.

### 3.3 Lifecycle: the Consolidator, an idle-time job

| Tier | Kept | How long |
|---|---|---|
| Hot | Last 24 h of states in RAM | 24 h |
| Warm | Steps + deduplicated snapshots | 30 days |
| Cold | Only the derived layer: facts, templates and counts, workflows, episode summaries, situation vectors with their pointers | Indefinitely |

Raw snapshots older than 30 days are deleted. Near-duplicate situations are merged, with their counts added together. The size target is under 1 GB per year.

- Commands: `tab forget --app X | --since T | --fact F`.
- Redaction at write time: Luhn card numbers, SSN-like patterns, and anything typed into a denylisted app.

### 3.4 Migration

Import the 40 `brain/logs/session-*.jsonl` files into the database as seed data and a first eval set.

## 4. Prediction ladder (brain), built for latency

**When predictions run.** Prediction is speculative and continuous.
- Every state or action change starts a prediction (150 ms debounce) and aborts the previous one (the existing `gen` counter plus an AbortSignal).
- The result is cached per state hash, so the ghost is usually ready by the time the user pauses.
- Keep `IDLE_MS` for model ghosts only. T0 and T1 ghosts may appear right away.

**T0, pattern (<5 ms).** The existing `pattern.ts`, with two extensions:
- A unit's targets may be AX `target_sig`s with a `grid` index, not only web list rows.
- Add **input-stream repetition**: k ≥ 2 repeats of the same template sequence with a varying slot (n, n+1; the next row; the next item in a list) → offer the next one, then "Do the remaining N". This needs no element structure, so it also covers spreadsheets and canvas apps.

**T1, memory (<25 ms).** Look up field facts (when an empty field is focused), habit-graph transitions, and the top situation kNN. These produce scored candidates. Show one directly if it is confident (calibrated on the eval set). Otherwise pass the candidates to T2.

**T2, local LLM (≤350 ms p50, ≤700 ms p95).**
- Runtime: `llama-server` (llama.cpp via Homebrew) as a child process managed by the brain. It supports prompt-prefix KV caching, `n_probs` logprobs, GBNF grammars and multimodal input.
- It sits behind a `ModelRuntime` interface, so MLX can be swapped in if it benchmarks faster.
- **The same shape as Jev (choose from candidates), but local:**
  - Code builds the candidates. `candidates.ts` becomes generic, without `VALUE_RES` or the GitHub/Terminal special cases: interactive elements near the focus, T1 suggestions, and workflow continuations.
  - The model outputs one index token under a grammar. **Confidence = the softmax probability of that token**, so there is a single forward pass and one or two decoded tokens.
- The model generates text only for an empty text field with no memory hit, with a short output cap (≤ 24 tokens). Longer text goes to the opt-in cloud tier.
- **Prompt laid out for cache hits:** the static system prompt and instructions, then the retrieved few-shot steps, then the compact state, then the recent actions. Uncached input stays under about 800 tokens: send the window's elements near focus, not the whole tree. This fixes Jev's "accuracy drops with irrelevant state" problem as well as latency.
- **Candidate models**, to be decided by a bake-off on the eval set:

  | Model (GGUF Q4_K_M) | Why consider it |
  |---|---|
  | Liquid LFM2-1.2B | Fast prefill on-device (the model in your notes) |
  | Qwen3-1.7B | |
  | Qwen2.5-3B | Only if latency allows |

  Pick by top-1 accuracy at the latency budget.
- **Embedder:** EmbeddingGemma-300M or bge-small, through a second `llama-server --embedding`, about 5–15 ms per text.
- **VLM:** LFM2-VL-450M for icon captions and LFM2-VL-1.6B for canvas windows. On demand only.
- All three fit in about 2.5 GB of RAM.
- **Delete `JevDecider`, `AnswerCache`, `~/.tab/jev-cache.json`, `npm run warm`, and the `BUY`/`SUBMIT` boosts.** Keep `ClaudeDecider` as the opt-in cloud tier, used only for long text and only when it is enabled.

**T3, async.** The vision VLM and the cloud model. Their results only upgrade a ghost if the user hasn't acted, and never cause flicker: a ghost that is already showing is replaced only by one with a higher score that has been ready for at least 150 ms.

**Ranking.** One scorer merges the tiers: tier prior × calibrated confidence × a penalty for recently dismissed ghosts (keep "ignoring is sticky", `dismissedKey`). The threshold of `SHOW_AT = 0.6` is re-fitted so that shown ghosts are about 85% precise.

## 5. Remove the hardcoding

- Delete `brain/src/calendar.ts`, `offerCalendarAfter`, `nativeApps`, `prDescription()`, `VALUE_RES`, and the Terminal-only clause in `predict()`.
- The Calendar beat should still work, but now as a learned workflow: do it once by hand, and Tab offers it next time.
- Move payments (`web/src/rail.ts`, `intent.ts`, `payment_required`) behind a `plugins/pay` flag. The demo sites stay as regression fixtures.
- Update the README and PLAN to the new architecture. Load `humanize-write` first.

## 6. Eval harness, built first and used throughout

- **`tab record`** runs the shell and brain with ghosts off, so you work normally for a few days across many apps.
- **`npm run eval`** replays `steps` offline through the ladder, at each step predicting the next user action. It reports:
  - coverage (the share of steps with a ghost);
  - precision of shown ghosts (target and value match);
  - keystrokes and clicks saved;
  - latency p50/p95 per tier and per app.

  **The per-app breakdown is the proof of generality.**
- It is used for the model bake-off, threshold calibration and regression tests. The old `npm run try` flows stay as an end-to-end smoke test.
- Later: LoRA fine-tuning of the chosen small model on your accepted and dismissed steps with MLX, measured with the same harness.

## Build order (each phase ends measurable)

1. **Sensor + recorder:** `AXSensor`, `ActionObserver`, privacy filters, the protocol additions, and the `memory.db` raw layer with migration. Check: record 1 day; snapshot p50 ≤ 50 ms in Finder, Notes, Mail, Slack, VS Code, Chrome and Numbers.
2. **Eval harness**, plus a baseline that runs the current pattern engine on the recorded data.
3. **Actuator:** generic click, type and key, with inline ghost text at the caret. Check: replay 50 recorded steps in 6 apps.
4. **Local LLM tier:** `ModelRuntime`, `LocalDecider`, generic candidates, speculative prediction, then the bake-off. Remove Jev.
5. **Memory derived layer:** provenance, field facts, templates and the habit graph, situation kNN, the Consolidator.
6. **T0 extensions:** grid units, input-stream repetition, and sequence extrapolation (the spreadsheet renumbering example).
7. **Vision:** OCR pseudo-elements, the icon-caption cache, the canvas VLM.
8. **Cleanup:** remove the hardcoding, the pay plugin flag, the opt-in cloud tier, and the docs.

## Critical files

- **Shell:** `shell/Sources/TabShell/NativeApp.swift` (→ `AXSensor.swift`, `Actuator.swift`), `InputTap.swift` (action capture), `main.swift` (wiring and exec routing), `TerminalReader.swift` (the `AX` helpers to reuse), `Protocol.swift`, `Overlay.swift` (caret placement for inline text).
- **Protocol:** `protocol/types.ts`, `protocol/CHANGES.md`.
- **Brain:** `brain/src/model.ts` (Decider → LocalDecider), `candidates.ts` (generic), `brain.ts` (predict ladder, routing, removing the hardcoding), `pattern.ts` (grid and stream repetition), `history.ts` and `state.ts` (backed by memory). New: `brain/src/memory/*`, `brain/src/runtime/llama.ts`, `brain/tools/eval.ts`, `brain/tools/import-logs.ts`.
- **Reuse:** the `gen` / `dismissedKey` / `modelCache` logic in `brain.ts`, `Workflow`/`unitFor`/`prov` in `pattern.ts`, `validate()` in `model.ts`, the sequence runner, and `replay.ts`.

## Verification

- `cd brain && npm test`: existing tests kept green, or rewritten where the hardcoding is removed. New unit tests for provenance, fact clustering, template mining, the habit graph, the ladder merge and the consolidator.
- `npm run eval` on the recorded days: a per-app table of coverage, precision and latency. Targets: shown-ghost precision ≥ 85%; p50 time to ghost ≤ 400 ms; snapshot ≤ 50 ms; T2 ≤ 350 ms p50 on the M2.
- `TabShell --selftest` / `--tap-selftest`, plus a new `--ax-bench <bundleId>` that prints snapshot timing and element counts.
- **Live check, with real Tab keys and no per-app code**, each run captured with `screencapture`:
  - a job-style web form autofilled from facts;
  - renumbering rows in Numbers;
  - a repeated Finder rename;
  - a Mail habit;
  - the Calendar beat, learned after doing it once by hand.

## Progress

### 2026-11-04: phases 1 and 2 (branch `more-work`, not committed)

**Phase 1, sensor and recorder.**
- `shell/.../AXSensor.swift` reads the focused window of any frontmost app.
  - It works from batched attribute reads, refreshes on AXObserver notifications with a 1 s poll as a fallback, and turns on the AX tree in Chrome and Electron apps.
  - Privacy: secure fields carry no value, and denylisted apps (password managers, plus `~/.tab/config.json` `denyApps`) report nothing.
  - The old Calendar-only `NativePoller` is gone. Element paths keep the old `id:`/`desc:`/`title:` form plus `#n` for duplicates, so the Calendar beat still resolves its targets.
- `ActionObserver.swift` turns the tap's raw input into `user_event`s for any app:
  - a click becomes the element it hit, in the app that owns that element;
  - a typing burst is committed with the value before and after (long texts store only the inserted span);
  - shortcuts and navigation keys become `key` steps.
- `brain/src/memory/store.ts` writes everything to `~/.tab/memory.db`, using `node:sqlite` and zstd:
  - content-addressed screens, delta-encoded against the previous screen of the same place;
  - steps with their before and after screens;
  - ghost outcomes and episodes;
  - redaction (cards, SSNs, API keys) at write time.

  Tools: `npm run memory -- stats | steps | forget | import`.
- The 206 MB of old session logs import into a 6.5 MB database, with 3 MB of compressed screens. AX and native events no longer go into `brain/logs/` unless `TAB_SESSION_LOG=full`.
- Snapshot timing (`TabShell --ax-bench`), p50:

  | App | Snapshot p50 |
  |---|---|
  | Finder | 3.5 ms |
  | Notes | 31 ms |
  | Chrome | 62 ms (748 nodes) |
  | VS Code | 55 ms |
  | Claude | 33 ms |

  Spotify (CEF) exposes no tree, so it needs the vision fallback.
- Verified live: TextEdit typing, Return, cmd+a and real clicks on Bold were recorded as resolved steps, with before and after screens.

**Phase 2, eval harness.** `npm run eval` replays memory.db online: it predicts first, then learns from the real step. The first memory tier, `memory/habits.ts`, is a habit graph over value-free templates with n-gram backoff and recency decay. Results on the imported hackathon logs (1,444 Chrome steps; mostly repeated rehearsals, so optimistic):

| Tier | top-1 | coverage / precision at ≥ 0.7 |
|---|---|---|
| habit | 41% | 23% / 85% |
| pattern (old engine) | 7% | 8% / 88% |
| ladder | 42% | 29% / 85% |

Latency: habit 0.07 ms p50.

**Next:** record a few days of real use (needs the hub + TabShell running with memory on). Then:
- Phase 3: the generic actuator. Typing via paste for long text, plus menus.
- Phase 4: llama.cpp, a model bake-off on the eval, and removing Jev.

### 2026-11-07: phases 3–6 (branch `more-work`, not committed)

**Local models.** llama.cpp 0.8.0 (Homebrew) and models in `~/.tab/models`:

| Model | Prompt processing | Generation | Used for |
|---|---|---|---|
| Qwen3-1.7B Q4_K_M | 800 tokens/s | 68 tokens/s | the default |
| LFM2.5-1.2B Q4_K_M | 1,160 tokens/s | 96 tokens/s | — |
| Qwen3-4B-Instruct Q4_K_M | — | — | tested only |
| EmbeddingGemma-300M Q8_0 | — | — | field facts |

`src/runtime/llama.ts` runs one `llama-server` per model, with prompt caching, and stops it when the hub exits.

Bake-off on the imported logs (every 2nd or 4th step):

| Model | Top pick right | Top 3 | Latency p50 |
|---|---|---|---|
| LFM2.5-1.2B | 18% | 48% | 416 ms |
| Qwen3-1.7B | 29% | 52% | 420 ms |
| Qwen3-4B | 33% | 53% | 962 ms |

All of them are overconfident. So the model is one input to a fitted combiner (`src/predict/ladder.ts`), not the thing that decides whether a ghost shows. On this repetitive demo data it doesn't add high-precision coverage. It should matter more on new screens and for text.

**Decider.** Jev is gone (`JevDecider`, the answer cache, `candidates.ts` and their tests). `src/predict/decider.ts` (`LocalDecider`) works in two steps:
- **fast, ~1 ms, shown before the idle pause:** sequences, habits and field facts.
- **after the pause, aborted on any input:** the local model (`src/predict/local.ts`). Code proposes generic options (`src/predict/generic.ts`), the model picks a letter, and an "open" field gets its value in a second short call ("choose, then fill").

The combiner keeps separate weights for fast-only and full candidates. `npm run eval -- --fit` fits them on data.

**Actuator** (`shell/.../Actuator.swift`):
- click: AXPress, else a real click.
- type: focus, select all, then keystrokes, or a paste that restores the clipboard for long text. It waits until the field shows the value.
- popup choose: waits until the popup shows the choice.
- any key combo, and navigate.
- `TabShell --exec '<json>'` runs one action, for testing.

**Field facts** (`src/memory/facts.ts`, `embed.ts`): forms are retrieval.
- Field names are embedded with EmbeddingGemma's sentence-similarity prompt, and cached in memory.db.
- Matches need similarity ≥ 0.70. Votes favour the closest field (weight e^15·(sim−1)).
- Guards: an opposed-word veto (first/last, full/last, billing/shipping) and a value-shape check (email, phone, URL, postcode).
- A full name also yields first-name and last-name facts. A dismissed fill is never offered for that field again.
- Live check, after one fill of a form, on a differently worded one: Work email → jane@acme.com, Previous employer → Initech, Current role → Staff engineer, Mobile number → the phone, Last name → Doe. City and Company website get nothing.

**Sequences** (`src/predict/sequence.ts`): consecutive rows of the same column whose values follow a rule (n+d, prefix+number with zero padding, a constant). It predicts the next row, and after three in a row it offers "Fill the remaining N". Without grid information it works from the keystroke stream.

**Testbed and e2e.** `TabShell --testbed [--signup]` is a native window (form, popup, checkbox, table, a second "Sign up" form). `npm run e2e` drives it with real, untagged input through TabShell.app and a scratch hub. 24 checks, all passing:
- recording: types with before and after screens, clicks, table cells with row and column;
- the actuator: type, paste and clipboard restore, choose, click, cell;
- a habit becomes a "Click Submit" ghost, and a real Tab runs it;
- "Work email" is filled from "Email" on another form;
- 10, 20, 30 by hand, then Tab gives 40, then Tab gives "Fill the remaining 2 (50 … 60)".

51 unit tests pass.

### 2026-11-07 (later): vision, icons, autocomplete, episodes, cleanup, latency (pushed to `origin/more-work`)

- **Vision fallback.** `VisionSensor.swift` uses ScreenCaptureKit and Apple Vision fast OCR, about 90 ms per window in steady state. Windows with fewer than 6 labelled controls get OCR elements (`ocr:<text>`) on their own queue.
  - Clicks on such windows are recorded against the OCR text under the pointer. The actuator clicks OCR targets at their screen position.
  - `npm run e2e:canvas` runs on a window with no AX tree: four (Open, Archive) rounds by hand, then Open brings a "Click Archive" ghost, and Tab clicks the drawn button.
  - **TabShell.app needs its own Screen Recording grant.** The test uses the debug binary for this reason.
- **Icon names.** Unlabeled icon-size controls are cropped, keyed by dHash, and named once by LFM2-VL-450M ("what object is shown": Trash can, Star, Gear, Printer, about 130 ms each). Names are cached in `~/.tab/icon-labels.json`. Window buttons are named from their AX subrole. Unlabeled controls with no id get their AX path in the habit signature.
- **Autocomplete while typing.** A non-empty focused field gets a completion from values typed before. A text ghost with `caret` draws only the rest of the text, at the insertion point. In the e2e, "Jane" becomes "Jane Doe".
- **Episode summaries.** While you're idle the hub has the local model write one line per finished task, embedded for search: `npm run memory -- summarize | episodes | search "<words>"`.
- **Consolidator.** It runs at hub start and every 6 hours: 30 days of screens (kept deltas are rewritten as keyframes), 90 days of steps, and form fills kept indefinitely.
- **Per-app code removed.**
  - The Calendar offer is gone. Its 7-step sequence is now a runner test fixture.
  - Terminal is read through AX. Long values keep the text around the caret, which in a terminal means the latest output. TerminalReader is opt-in (`TAB_TERM_READER=1`).
  - URLs printed on screen become "Open …" candidates.
  - Jev is gone from env, preflight, tools and `web/`.
- **The local model live.**
  - A warm-up request at start gives a first call of about 1 s and about 430 ms p50 afterwards.
  - Generated values that echo the field's label are dropped.
  - Values that appear nowhere you've been are capped at 0.3×, so they don't show as ghosts.
- **Latency.** **135 ms from click to ghost** in the e2e. The AX debounce is 30 ms after quiet and 100 ms during bursts. The hub predicts 40 ms after a screen settles. `TAB_TRACE=1` prints the timeline.
- **Tests.** 53 unit tests. `npm run e2e`: 26 checks. `npm run e2e:canvas`: 7 checks.

**Open items:**
- Grant TabShell Screen Recording.
- Record a few days of real use, then `npm run eval -- --model qwen --fit` to fit the combiner on real data.
- Opt-in cloud only for long text: today, `TAB_DECIDER=claude` swaps the whole decider instead.
- Incremental AX refresh for very large windows (55–62 ms snapshots in Chrome and VS Code).
