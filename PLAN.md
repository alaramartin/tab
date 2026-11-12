# Tab: plan and history

Tab predicts your next action on the Mac and shows it as a ghost: a highlight on the button you're about to click, or gray text in the field you're about to fill. Tab does it, Esc dismisses it.

This file records how Tab was planned and built. It has five parts: what's still to do, the hackathon version (October 2026), the general version that followed (November 2026), how Tab works now, and how to develop it. Run instructions are in the README. Design details live in the code, next to what they describe.

---

## 1. Still to do

Items marked *(needs you)* need a decision or the Mac to yourself. The rest a session can do alone.

1. **Notice payment requests in any app.** *(needs you: pick the approach)* The hub can check and pay an x402 402 (`brain/src/pay/`), but nothing reports them yet. A detector would hold the request, send `payment_required` to the hub, and release it with `payment_done` (`protocol/types.ts`). Options: a local proxy, or a small browser extension.
2. **Design the HUD.** *(needs you)* It's a placeholder: status, last payment, and an expandable Tab did / You did (`shell/Sources/TabShell/HUD.swift`; `TabShell --render-hud out.png` draws every state offscreen).
3. **Run the end-to-end tests.** *(needs you away from the Mac: they move the mouse and type)* `npm run e2e:chores` (teach once, repeat, then do the remaining) is written but has never run. Patching a changed checkbox, slider or popup in place (`AXSensor.changed`) and subtree re-walks (`AXTreeCache`) have never run on a live window with real notifications; `npm run e2e` covers them, and `npm run e2e:canvas` covers canvas shapes. `npm run e2e` last failed because the Mac was in use; `npm run e2e:canvas` passes. First rebuild and relaunch TabShell (`shell/scripts/build-shell.sh --run`), and leave port 7800 free (no hub running).
4. **Learn from real use.** *(needs a few days of your use)* Record a few days, fit the combiner (`npm run eval -- --llm --fit`), then try fine-tuning the local model on accepted and dismissed ghosts.
5. **Faint canvas shapes.** Vision's contours miss low-contrast shapes, such as the canvas testbed's light gray buttons on white (0.9 on 1.0; raising `contrastAdjustment` didn't help), so their text keeps its own small rect. An edge or saliency pass could find them (`VisionSensor.objects`; `--vision-selftest` draws the testbed's canvas).
6. **Try rules on real tasks.** *(needs you)* Rules (HUD → Rules) have only run in unit tests and offscreen renders. Write two or three, do the tasks they describe, and check that the Yes/No trigger check fires at the right moments (`MATCH_AT` 0.7 in `brain/src/rules.ts`) and that goal-guided ghosts (shown from 0.4) can finish a goal in the named app. Typing in the HUD's rule field should hand the keyboard back to the app in front after Return or Esc.

---

## 2. The hackathon version (Oct 13–14, 2026)

Built for the Paradigm Frontiers 2026 hackathon, due Wednesday Oct 14 at 4 pm PT. That code is frozen at [alaramartin/paradigmhacks](https://github.com/alaramartin/paradigmhacks).

### The plan

The rule was **"the demo is the spec"**: build only what four demo flows need.

1. **Buy tickets, and get stopped by a junk fee.** Checkout, Buy, then `Pay $0.30 · tickets.localhost ⇥` paid an HTTP 402 with testnet USDC. Before paying, Tab compared the amount requested with what the page showed. A resale site asking $0.51 for a $0.30 page got a red `Blocked` ghost.
2. **`git push` to an open pull request.** The push URL in Terminal became `Open pull request ⇥`. Then a description written from the commits, then `Create pull request`.
3. **Release day, teach once.** You close one tracker ticket by hand (search, open, set Done, link the PR, Save). Then `Repeat for ENG-150 · #13 ⇥`, then `Do the remaining 3 ⇥`, with no model call.
4. **One button.** A prescription refill done entirely with a foot pedal, compared with the same form in macOS Switch Control.

**UX rules, kept in v2:**
- With no ghost on screen, Tab and Esc behave normally.
- Any other input hides the ghost, and ignoring a ghost costs nothing.
- The pill says exactly what will happen.
- Model ghosts wait for a 600 ms pause.
- `blocked` ghosts refuse loudly.
- Only the user pays.

**Architecture.** Three processes around a websocket hub on `127.0.0.1:7800`:

| Part | What it did |
|---|---|
| **TabShell** (Swift) | Drew the ghosts and HUD, owned Tab and Esc, read Terminal, switched apps |
| **Brain** (TypeScript) | Routed messages, ran the predict loop, the pattern rule and one model call, and ran sequences |
| **Web + Pay** (TypeScript) | Drove Chrome over CDP, intercepted 402s, paid, ran the intent check and the five demo sites |

A frozen protocol (`protocol/types.ts`) let all three be built in parallel.

**Deliberately cut:** reading arbitrary apps through Accessibility, native clicking and typing, spreadsheets, and retrieval over past examples. Most of that became v2.

### How we worked

- **Three agents:** A (shell), B (brain) and C (web). Each owned its files and worked from its own section of the plan.
- **A shared log:** `STATUS.md`, with per-agent Done, In progress, Blocked and Needs human sections, plus notes from one agent to another.
- **Humans for the rest:** logins, wallet funding, permissions, and calls on scope.
- **A look-and-try loop:** every change was checked on the real pages with screenshots in `design/proof/`. `npm run try` replayed whole flows headlessly, and `preflight.sh` checked the demo Mac before each rehearsal.
- **Milestones by the clock:** skeleton at 02:00, flow 1 at 04:00, agents working on while the humans slept, flows 2 and 3 at 10:30, flow 4 at 12:30, freeze at 13:00, then rehearsals and a backup video.

### What changed along the way

- **The model was Jev** (TypeSafe), which picks from options and scores them but can't write text. So code built the candidate actions and Jev chose one, and the PR description came from a template.
  - Several per-site nudges were needed: a "submits the form you just filled" hint, purchase-button boosts, and a demo email worded so Jev would tick a checkbox.
  - Venue wifi slowed Jev from about 0.15 s to as much as 5 s. Fix: a 5 s timeout plus an answer cache keyed by screen. It had to be warmed by rehearsing on the demo network.
- **Payments moved to Tempo testnet (MPP) at 10:45 on demo day,** with x402 on Base Sepolia behind `PAY_RAIL` as the fallback. It went live at 11:31. Tempo's gateway returned 502s on fast broadcasts, so the server re-sends and polls.
- **The pattern engine grew remembered workflows.** A chore learned once was saved to disk and offered for a whole list after a restart (`Do all 6 from v1.4.0`).
- **A stretch goal became the first native-app work.** After a ticket purchase, `Add Night Owls · Fri 9pm to Calendar` filled a Calendar event through Accessibility.
  - It was built on a branch and worked 5 of 5 runs, after fixes for timing, cold launches and Escape discarding events.
  - The ghost was anchored on Calendar's Dock icon, and the branch was merged at 15:00.
  - It was one hardcoded seven-step sequence: the kind of per-app code v2 removed.
- **Late design calls:** red ghosts and a simpler HUD.

**Result:** all four flows worked end to end on the demo Mac, paying on Tempo. The limits were clear, though. Tab knew three apps (Chrome, Terminal, Calendar), each wired by hand. Prediction depended on a remote model that was slow on bad networks. And Jev needed per-site regexes and boosts.

---

## 3. v2: general and local (Nov 4–7, 2026)

**The goal:** a tab autocomplete for the whole computer. Any app, no per-app code, visuals where Accessibility gives nothing, and low latency, which was the main concern. It started from two ideas in your notes:
- Record actions as text from the Accessibility tree, not pixels, so they can be embedded and searched.
- "Forms are retrieval, sequences are patterns": two kinds of prediction need two kinds of predictor.

**Decisions made up front:**
- M-series Macs with 16 GB or more.
- Local-first, with Claude as an opt-in only for long text (removed later: Tab is local only).
- Chrome read through Accessibility like any other app, with CDP optional.
- Always-on recording, with a denylist and never password fields.

### What was built, in order, and what changed

1. **Perception and recording.**
   - `AXSensor` reads the front window of any app and turns on the AX tree in Chrome and Electron apps.
   - Snapshots take 1–80 ms. Chrome, VS Code and Claude are the slow ones; Spotify (CEF) exposes nothing.
   - `ActionObserver` resolves each click to the control it hit (and to the app that owns it), each typing burst to its field with the value before and after, and records shortcuts.
   - The first live test turned up two bugs: a system dialog's clicks were credited to TextEdit, and whole documents were stored per keystroke burst. Fixed by crediting the owning process and storing only the inserted text for long fields.
2. **Memory (`~/.tab/memory.db`).**
   - Screens are stored by content, once, as patches on the previous screen of the same place. Steps link the screens before and after.
   - The old 206 MB of logs became 6.5 MB (3 MB of screens).
   - Cards, SSNs and keys are redacted on write. A type step's "before" screen is the one from before the typing began.
   - Later additions: the Consolidator (30 days of screens, 90 of steps, form fills kept indefinitely), one-line episode summaries searchable by meaning, Pause, Forget the Last Hour, and `onlyApps` and `denyApps`.
3. **An eval before any model.**
   - `npm run eval` replays memory online: predict, then learn.
   - On the old logs, a habit graph over value-free action templates was right 41% of the time on its top pick and 85% right at ≥ 0.7. The old pattern engine was 88% right on the 8% of steps it covered.
4. **The local model, and what the eval said about it.**
   - Bake-off on the eval:

     | Model | Top pick right | Latency p50 |
     |---|---|---|
     | LFM2.5-1.2B | 18% | 416 ms |
     | Qwen3-1.7B | 29% | about 420 ms |
     | Qwen3-4B | 33% | 962 ms |

   - All three were overconfident. So the model became one input to a fitted logistic combiner instead of the thing that decides whether a ghost shows.
   - Fixes along the way:
     - Values from other screens are extracted generically, replacing Jev-era regexes.
     - "Choose, then fill": the model picks a field, then writes its value in a second short call.
     - Values that just echo the field's label are dropped, and invented (ungrounded) values are capped.
     - A warm-up request at start.
   - Jev was removed.
5. **Field facts (forms are retrieval).**
   - Field names are embedded with EmbeddingGemma.
   - Labels with a single distance threshold failed (first and last name scored 0.85). The fix added a veto on opposing words, a check that the value has the right shape (email, phone and so on), and splitting full names.
   - Later: autocomplete while typing, drawn at the insertion point.
6. **Sequences.** Values that follow a rule down a column (1, 2, 3; ENG-141, ENG-142) predict the next row, then "Fill the remaining N".
7. **Acting.**
   - `Actuator`: AXPress or a real click, type or paste (the clipboard is restored afterwards), dropdown choices, any key combo.
   - Testing moved to Tab's own windows (`--testbed`) after TextEdit test documents were autosaved to iCloud. `npm run e2e` then ran the whole loop: a habit done four times becomes a ghost, a real Tab press runs it, forms fill from other forms, and rows number themselves.
8. **Vision.**
   - Windows with little Accessibility get on-device OCR (about 90 ms), and clicks on them resolve to the OCR'd text.
   - Unlabeled icons are named once by LFM2-VL-450M. Asking "what object is shown" worked; asking "what action" made the model copy the prompt's example.
   - This needs Tab's own Screen Recording grant.
9. **Latency.** Click to ghost is 131–135 ms: a 30 ms AX debounce after a quiet moment, prediction 40 ms after a screen settles, and typing patched in place.
10. **Cleanup and privacy.**
    - The Calendar beat became a test fixture, Terminal is read through AX, and URLs on screen became "Open …" candidates.
    - Logs hold no values by default.
    - The opt-in Claude tier (`TAB_CLOUD=1`) was limited to long text, then removed in the simplifying pass below.

11. **Later the same day (Nov 7).**
    - Each typed value records where it came from: copied from a screen, the next in a sequence, typed before, or new. A habit whose value is always copied from the same field fills that field's current value.
    - The local model's prompt includes up to two summaries of tasks finished in the same app in the last day.
    - A new fast tier, similar moments: after a step in one app, it offers what followed a similar step in other apps.
    - In windows Accessibility can't read, Vision finds icon-sized shapes (contours), and the icon namer names them. `TabShell --vision-selftest` checks this offscreen.
    - Chores test windows (`--testbed --chores`) and `npm run e2e:chores`.
    - A changed checkbox, slider or popup is patched in place like typing, so its screen goes out without a full walk.

12. **Nov 11.**
    - Provenance knows facts and rewrites: a value typed before into a different kind of field is a `fact`, and a copied value or fact can carry a transform (case, digits only, a date in another format; `memory/transform.ts`). A habit fed by the same fact fills that fact's newest value, rewritten the same way.
    - Search Memory… in the menu bar: a panel that searches episode summaries by meaning and by their words (words alone without the embedding model), via `memory_search` / `memory_results`. Clicking a result opens its app. `TabShell --render-memory-search out.png` draws it offscreen.
    - Subtree re-walks: each walk caches every element's attributes (`AXTreeCache`). A change that names its container (layout, selection, focus, title) drops only that subtree, and the next walk reads just it from the app and the rest from the cache, so paths stay numbered across the whole window exactly as a full walk numbers them. Windows opening, elements destroyed and the 1 s fallback poll still walk everything. `TabShell --subtree-selftest` checks it on an offscreen testbed: an unchanged walk reads nothing, and after a table edit the subtree walk equals a full one.
    - Canvas shapes: besides icons, Vision keeps larger top-level contours (24 pt across up to 60% of the window, not thin lines) as elements: diagram boxes, images, game pieces. A shape with one line of text inside becomes that line's element, grown to the shape; one with several lines is named by them; one without goes to the icon namer. `--vision-selftest` covers a labelled box, an unlabelled piece, and the canvas testbed's buttons appearing once each.
    - Rules, the user's own offers: a Rules row in the HUD lists them (on/off, remove) with a field for a new one, kept in `~/.tab/rules.json`. A rule is split into a trigger and a goal, plus the app the goal names (`brain/src/rules.ts`). After a finishing step and a pause, the local model checks each trigger (Yes/No) and writes the goal for this case; a match is a ghost, `Rule: … ⇥`. Accepting it opens the app by name and makes the goal the model's aim: while a goal is set, only the model's steps toward it are offered (from 0.4), until it lapses after 3 minutes without an accepted step, Esc, or stop in the HUD. Without the model, triggers match by their words. This replaced the idea of a few built-in cross-app offers.

### How we worked

- The plan was written first and kept as a progress log.
- The eval came before tuning, and the end-to-end tests ran on Tab's own windows, never your apps.
- Work was committed and pushed as it went. On Nov 7, v2 moved to its own repo, [alaramartin/tab](https://github.com/alaramartin/tab).

### Simplifying (Nov 7)

Once v2 worked, everything that existed only for the hackathon or as an alternative went:
- **Local only:** the Claude decider, the Claude long-text option and the Anthropic SDK were removed. Qwen3-1.7B is the only predictor model.
- **Readers:** the Chrome layer (`web/`: CDP, demo sites, payment rails), the Terminal-only reader, the Calendar beat and the Dock ghost were removed. Chrome is read like every other app.
- **Pattern engine:** rebuilt on Accessibility lists and table rows in any app. Chores live in memory.db, and steps carry their window.
- **Payments:** the core moved into the hub: x402 only, with the screen check and the ledger. A future detector reports 402s to the hub.
- **Settings and switches:** the slow OCR mode, port and tuning knobs, and the separate debug switches were removed. One `TAB_DEBUG` remains, and the logs hold no values without it.
- **HUD:** compact, with the Tab did / You did breakdown behind a click. The end-of-demo Reveal card was removed.
- **Files:** Jev's docs, demo-day scripts, `design/`, the old fixtures and the design skills in `.claude/` were removed. The two video projects moved into `demo-videos/`.

---

## 4. How Tab works

```
TabShell (Swift, menu bar)                Hub (TypeScript, ws://127.0.0.1:7800)
  AXSensor        the front window   ──▶    memory.db (SQLite: screens, steps, ghosts, facts)
  VisionSensor    OCR, icons                fast predictions: chores, sequences, habits, form facts,
                                            similar moments in other apps                             ~1 ms
  ActionObserver  your clicks, typing       local LLM (Qwen3-1.7B on llama.cpp), after a pause       ~0.4 s
  Actuator        click / type / key  ◀──   one calibrated score per suggestion; a ghost above 0.6
  Overlay, HUD    the ghost                 payments (x402)
```

- **Reading the screen** (`shell/Sources/TabShell/AXSensor.swift`, `VisionSensor.swift`): a snapshot of the front window takes 1–60 ms. A changed value patches its one element, and a change inside one container re-reads only that container. Each element has its role, label, value, section, and row and column in a table. Icon-only buttons are named once by a small local vision model. A window with little Accessibility is read with on-device OCR, and the icons and larger shapes in it (diagram boxes, images, game pieces) are found and named the same way, or by the text inside them.
- **Memory** (`ActionObserver.swift`, `brain/src/memory/`): every click, typing burst and shortcut is saved with the element it hit and the screens before and after it.
  - Screens are stored once each, and a changed screen is stored as a small patch on the one before.
  - A typed value also records where it came from (copied from a screen, the next in a sequence, typed before, a known fact from another field) and how it was rewritten (case, digits only, a date format), so a step can be replayed with new values.
  - Card numbers, SSNs and API keys are redacted before anything is saved. Password fields and password managers are never recorded.
  - Screens are kept for 30 days and steps for 90; form fills are kept until you delete them. While you're idle, finished tasks get one-line summaries you can search from the menu bar (Search Memory…).
- **Prediction** (`brain/src/predict/`, `brain/src/pattern.ts`): the fast predictions run on every change. They include what you did after a similar step in other apps. The local model only runs once you pause, and stops as soon as you do something.
- **Rules** (`brain/src/rules.ts`, HUD → Rules): rules you write in plain words. When the local model sees you've just done what a rule's trigger says, the rule's goal is offered as a ghost, and accepting it turns the next ghosts into steps toward that goal.
- **Acting** (`Actuator.swift`): presses or clicks, types or pastes (your clipboard is put back afterwards), chooses from dropdowns, presses key combinations.

## 5. Development

| Command (in `brain/`) | What it does |
| --- | --- |
| `npm test` | Unit tests |
| `npm run e2e` | End to end on TabShell's own test window: recording, acting, a habit becoming a ghost, form fills, completions, row numbering. It moves the real mouse and types, so leave the Mac alone while it runs. |
| `npm run e2e:canvas` | The same for a window with no Accessibility tree |
| `npm run e2e:chores` | Teach a chore once on a list, repeat it twice with Tab, then do the remaining rows |
| `npm run eval [-- --llm]` | Replays memory.db and scores each predictor: accuracy, coverage at 85% precision, latency, per app |
| `npm run memory -- stats` | What's in memory |
| `npm run memory -- forget --app <id>` | Deletes what was recorded for an app (`--since 2h` deletes by time) |
| `npm run memory -- search <words>` | Finds past tasks by meaning |
| `npm run send -- --listen` | Prints everything the hub sends |

### Rules for working on Tab

- **Everything stays on the Mac.** Nothing a user does may reach a server: models run locally, and there's no telemetry and no cloud option.
- **Tests never touch your own apps.** End-to-end tests use TabShell's own windows (`--testbed`). TextEdit, Notes and Mail sync or autosave to iCloud.
- **Commit and push as you go**, to `main` of [alaramartin/tab](https://github.com/alaramartin/tab), and only after `npx tsc --noEmit` and `npm test` pass in `brain/` (and `swift build` in `shell/` for shell changes). Never push to alaramartin/paradigmhacks, which is frozen.
- **No keys in the repo.** `PAYER_PRIVATE_KEY` lives in `.env`, testnet only.
- **Code and docs describe what is, not what was.** History goes in commit messages and sections 2 and 3 of this file.

### Shell tools

`TabShell --ax-dump [app]`, `--ax-bench`, `--ocr`, `--exec '<action>'` and `--testbed` help when working on the shell. `--tap-selftest` and `--vision-selftest` run offscreen and need no permissions, `--subtree-selftest` runs offscreen with the Accessibility grant, and `--render-hud` and `--render-memory-search <out.png>` draw those windows offscreen.
