# Tab

> **Status:** In progress. Follow [@alara_martin\_](https://x.com/alara_martin_) for updates.

Tab predicts your next action on your Mac and shows it as a ghost: a highlight on the button you're about to click, or gray text in the field you're about to fill. Press **Tab** to do it. Press **Esc** to dismiss it.

It works in any app. It reads the front window through macOS Accessibility, reads the text of windows that expose nothing (canvas apps, games, some Electron apps) with on-device text recognition, learns from what you do, and predicts with models that run on your Mac. Nothing you do is sent anywhere.

What it does:

- **Repeats your habits.** If you usually Archive after Reply, then the next time you Reply, Archive is one keystroke away.
- **Fills forms from your past forms.** Type your email into "Email" once, and a "Work email" field on another site offers it. Fields are matched by meaning, with checks so "Last name" never gets a full name and a phone field never gets an email.
- **Completes what you're typing** with things you've typed before.
- **Continues sequences.** Number three rows (10, 20, 30) and it offers 40, then "Fill the remaining 3".
- **Repeats a chore for the next item.** Close one ticket from a list by hand, and it offers the same steps for the next one, then for all the rest.
- **Pays when you say so.** For an HTTP 402 payment request (x402), the ghost becomes `Pay $0.30 · example.com ⇥`. Tab checks the amount against the price on screen first, and blocks a mismatch. Noticing these requests in any app is still being built (see [`PLAN.md`](PLAN.md)).

How Tab works, how to develop it, how it was built and what's still to do: [`PLAN.md`](PLAN.md).

## Running it

Needs macOS 14+, Node 24 and Homebrew. `shell/scripts/setup.sh` installs everything and builds TabShell. Add `--agent` to start the hub at login. `shell/scripts/doctor.sh` checks the result.

Then grant TabShell **Accessibility** (required) and **Screen Recording** (for reading windows without Accessibility, and for icon names) in System Settings → Privacy & Security.

The menu bar icon has **Pause Tab** (nothing is read, recorded or suggested until you resume) and **Forget the Last Hour**. Click the top row of the HUD to see how much Tab did for you.

### Settings

| What | How |
| --- | --- |
| Apps Tab never reads or records | `~/.tab/config.json`: `{"denyApps": ["com.example.app"]}`. Password managers are always excluded. |
| Only read and record some apps | `~/.tab/config.json`: `{"onlyApps": ["com.apple.mail", "com.google.Chrome"]}`. Changes apply right away. |
| Suggest, but save nothing to disk | `TAB_MEMORY=off` |
| Fast predictions only, no local LLM | `TAB_LLM=off` |
| Details in the logs | `TAB_DEBUG=1` (ghost text, typed values and timings) |
| Pay from a wallet | `PAYER_PRIVATE_KEY` in `.env` (USDC on Base Sepolia, a testnet) |

To remove Tab and everything it saved: `shell/scripts/uninstall.sh --yes`.
