# Tab: plan and history

Tab predicts your next action on the Mac and shows it as a ghost: a highlight on the button you're about to click, or gray text in the field you're about to fill. Tab does it, Esc dismisses it.

This file records how Tab was planned and built. It has three parts: the hackathon version (October 2026), the general version that followed (November 2026), and what's still to do. Run instructions are in the README. Design details live in the code, next to what they describe.

---

## 1. The hackathon version (Oct 13–14, 2026)

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

## 2. v2: general and local (Nov 4–7, 2026)

**The goal:** a tab autocomplete for the whole computer. Any app, no per-app code, visuals where Accessibility gives nothing, and low latency, which was the main concern. It started from two ideas in your notes:
- Record actions as text from the Accessibility tree, not pixels, so they can be embedded and searched.
- "Forms are retrieval, sequences are patterns": two kinds of prediction need two kinds of predictor.

**Decisions made up front:**
- M-series Macs with 16 GB or more.
- Local-first, with Claude as an opt-in only for long text.
- Chrome read through Accessibility like any other app, with CDP optional.
- Always-on recording, with a denylist and never password fields.

### Architecture

```
TabShell (Swift)                          Hub + brain (TypeScript, :7800)
  AXSensor       any app's window   ──▶    memory.db: screens, steps, ghosts, facts, episodes
  VisionSensor   OCR + icon crops           fast tiers (~1 ms): sequences, habits, field facts
  ActionObserver clicks, typing             local LLM (Qwen3-1.7B, llama.cpp) after a pause, ~0.4 s
  Actuator       click/type/key     ◀──    combiner → one calibrated score → ghost above 0.6
  Overlay + HUD  the ghost
```

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
    - The opt-in Claude tier (`TAB_CLOUD=1`) is used for long text only.

### How we worked

- The plan was written first and kept as a progress log.
- The eval came before tuning, and the end-to-end tests ran on Tab's own windows, never your apps.
- Work was committed and pushed as it went. On Nov 7, v2 moved to its own repo, [alaramartin/tab](https://github.com/alaramartin/tab).

---

### Simplifying (Nov 7)

Once v2 worked, everything that existed only for the hackathon or as an alternative went:
- **Local only:** the Claude decider, the Claude long-text option and the Anthropic SDK were removed. Qwen3-1.7B is the only predictor model.
- **Readers:** the Chrome layer (`web/`: CDP, demo sites, payment rails), the Terminal-only reader, the Calendar beat and the Dock ghost were removed. Chrome is read like every other app.
- **Pattern engine:** rebuilt on Accessibility lists and table rows in any app. Chores live in memory.db, and steps carry their window.
- **Payments:** the core moved into the hub: x402 only, with the screen check and the ledger. A future detector reports 402s to the hub.
- **Settings and switches:** the slow OCR mode, port and tuning knobs, and the separate debug switches were removed. One `TAB_DEBUG` remains, and the logs hold no values without it.
- **HUD:** compact, with the Tab did / You did breakdown behind a click. The end-of-demo Reveal card was removed.
- **Files:** Jev's docs, demo-day scripts, `design/` and the old fixtures were removed. The two video projects moved into `demo-videos/`.

## 3. Still to do

1. **Notice payment requests in any app.** The hub can check and pay an x402 402 (`brain/src/pay/`), but nothing reports them yet. A detector would hold the request, send `payment_required` to the hub, and release it with `payment_done` (`protocol/types.ts`). Options: a local proxy, or a small browser extension.
2. **Design the HUD.** It's a placeholder: status, last payment, and an expandable Tab did / You did.
3. **Test the pattern engine live.** Add a list window and a form window to the testbed, and an e2e step for teach once, repeat, and "do the remaining".
4. **Store where each value came from** (copied from a screen, a known fact, n+1, a transform) with each step, so a recorded step can replay in a new context.
5. **Similar past moments across apps.** Embed situations, so a moment in one app can recall what you did in a similar one elsewhere.
6. **Incremental Accessibility refresh.** Re-walk only the subtree a notification names. Big windows still hit the 80 ms budget.
7. **A vision-model pass for canvas windows,** beyond OCR.
8. **Learn from real use.** Record a few days, fit the combiner (`npm run eval -- --llm --fit`), then try fine-tuning the local model on accepted and dismissed ghosts.
9. **Feed episode summaries to the model** as long-range context, and search memory from the app, not just the command line.
10. **Maybe: a few built-in cross-app offers.** For example, after booking something, offer to add it to Calendar. Only where learning from use isn't enough.
