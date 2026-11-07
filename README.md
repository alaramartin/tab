# Tab

> **Status:** In progress. Follow [@alara_martin\_](https://x.com/alara_martin_) for updates.

Tab predicts your next action on your Mac and shows it as a ghost: a highlight on the button you're about to click, or gray text in the field you're about to fill. Press **Tab** to do it. Press **Esc** to dismiss it.

It works in any app without per-app code. It reads the front window through macOS Accessibility, falls back to on-device text recognition for windows that expose nothing (canvas apps, games, some Electron and CEF apps), learns from what you do, and predicts with local models. Nothing leaves the Mac.

Some things it does today:

- **Repeats your habits.** After Reply you usually Archive, so the next time you Reply, Archive is one keystroke away.
- **Fills forms from your past forms.** Type your email into "Email" once, and a "Work email" field on another site offers it. Field names are matched by meaning (embeddings), with checks so "Last name" never gets a full name and a phone field never gets an email.
- **Continues sequences.** Number three rows (10, 20, 30) and it offers 40, then "Fill the remaining N".
- **Repeats chores across pages** (the hackathon's pattern engine) and opens URLs printed on screen.

## How it works

```
TabShell (Swift, menu bar)                Hub + brain (TypeScript, ws://127.0.0.1:7800)
  AXSensor        any app's window   ──▶    memory.db  (SQLite: screens, steps, ghosts, facts)
  VisionSensor    OCR when AX is poor        prediction ladder
  ActionObserver  your clicks and typing       sequences · habits · field facts      ~1 ms
  Actuator        click / type / key   ◀──     local LLM (Qwen3-1.7B, llama.cpp)     ~0.4 s, only after a pause
  Overlay + HUD   the ghost                    combiner → one calibrated score
```

- **Perception** (`shell/Sources/TabShell/AXSensor.swift`, `VisionSensor.swift`): one snapshot of the front window takes 1–60 ms, depending on the app. Elements carry role, label, value, section, and table row and column.
- **Recording** (`ActionObserver.swift`, `brain/src/memory/store.ts`): every click, typing burst and shortcut is resolved to the element it hit and stored with the screens before and after it. Screens are stored once and delta-encoded, so 206 MB of old logs became 6.5 MB. Card numbers, SSNs and API keys are redacted on write. Password fields and password managers are never recorded. Old screens are pruned after 30 days and steps after 90; form fills are kept, because field facts come from them.
- **Prediction** (`brain/src/predict/`): the fast tiers run on every change. The local model reranks candidates and fills values, and only runs once you pause. A logistic combiner turns all of it into one probability, and a ghost shows above 0.6.
- **Execution** (`Actuator.swift`): AXPress or a real click, typing or pasting (your clipboard is restored afterwards), any key combo, dropdown choices.

How Tab was planned and built, and what's still to do, is in [`PLAN.md`](PLAN.md).

## Running it

Needs macOS 14+, Node 24 and Homebrew. `shell/scripts/setup.sh` does all of the below (add `--agent` to start the hub at login), and `shell/scripts/doctor.sh` checks the result.

```sh
brew install llama.cpp
mkdir -p ~/.tab/models && cd ~/.tab/models
curl -LO https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf
curl -LO https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf

cd brain && npm i && npm start            # hub; starts the models in the background
shell/scripts/build-shell.sh --run        # TabShell.app; log in ~/.tab/shell.log
```

Grant TabShell **Accessibility** (required) and **Screen Recording** (for the OCR fallback and icon names) in System Settings → Privacy & Security.

The menu bar icon has **Pause Tab** (nothing is read, recorded or suggested until you resume) and **Forget the Last Hour**.

Settings:

| What                                                | How                                                                                                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apps never to read or record                        | `~/.tab/config.json`: `{"denyApps": ["com.example.app"]}` (password managers are always excluded)                                                                                             |
| Read and record **only** some apps                  | `~/.tab/config.json`: `{"onlyApps": ["com.apple.mail", "com.google.Chrome"]}`. Everything else is ignored. Edits apply right away.                                                            |
| Run without the local LLM (fast tiers only) | `TAB_LLM=off` |
| Turn memory off (suggest, but save nothing to disk) | `TAB_MEMORY=off`                                                                                                                                                                              |
| Debug details in the logs (off by default) | `TAB_DEBUG=1`: ghost text, typed values and timings in the hub's and TabShell's logs |

## Tools

| Command (in `brain/`)                 | What it does                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npm test`                            | Unit tests                                                                                                   |
| `npm run e2e`                         | End to end on TabShell's own test window: recording, actuator, habit → ghost → Tab, form fill, row numbering |
| `npm run e2e:canvas`                  | The OCR path on a window with no Accessibility tree                                                          |
| `npm run eval [-- --model qwen]`      | Replays memory.db and scores every tier: accuracy, coverage at 85% precision, latency, per app               |
| `npm run memory -- stats`             | What's in memory                                                                                             |
| `npm run memory -- forget --app <id>` | Deletes what was recorded for an app (`--since 2h` deletes by time)                                          |

`TabShell --ax-dump [app]`, `--ax-bench`, `--ocr`, `--exec '<action>'` and `--testbed` help when working on the shell.
