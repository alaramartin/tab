// Messages between TabShell, the hub and payment detectors. Every message has a `type`.
// Coordinates: global screen points, origin = top-left of the main display.
export type Rect = { x: number; y: number; w: number; h: number };

export type Role =
    | "button"
    | "link"
    | "textfield"
    | "textarea"
    | "select"
    | "checkbox"
    | "text"
    | "cell"
    | "row"
    | "menuitem"
    | "tab"
    | "slider"
    | "image"
    | "other";

/** One element of a window, as read through Accessibility (or OCR, path "ocr:…"). */
export interface El {
    id: string; // stable across snapshots where possible (same as path)
    role: Role;
    label: string; // accessible name or visible text, ≤ 80 chars
    value?: string; // current value (fields); long text is kept around the insertion point
    options?: string[]; // role 'select': option labels, when the app exposes them
    checked?: boolean; // checkboxes and toggles
    rect: Rect;
    enabled: boolean;
    path?: string; // how to find it again: id:/desc:/title:/text:/role:… plus #n for duplicates
    list?: { key: string; index: number; field?: string }; // an item in a repeated structure (table row, list entry)
    section?: string; // nearest labelled container, e.g. "Shipping address"
    axId?: string; // AXIdentifier
    placeholder?: string;
    help?: string;
    focused?: boolean;
    secure?: boolean; // password field: never carries a value
    grid?: { row: number; col?: number }; // table cell / row position
    caret?: Rect; // insertion point of the focused text field
}

/** The front window of an app. */
export interface ScreenState {
    type: "state";
    app: string; // bundle id, or "exe:<name>" for a bare executable
    window: string;
    url?: string; // when the window shows a web page
    elements: El[]; // visible only, ≤ 200, interactive first, then text
    seq: number;
    ts: number;
    nodes?: number; // AX nodes walked (diagnostics)
    vision?: boolean; // some elements were read from pixels
    covered?: boolean; // another app's window covers most of it (a Screen Time block, another app's dialog): nothing is offered on it
}

/** Something the user did, resolved to the element it hit. */
export interface UserEvent {
    type: "user_event";
    app: string;
    window?: string;
    url?: string;
    kind: "click" | "type" | "key";
    target?: El;
    value?: string; // typed text, key name ("cmd+s", "Return"), or the click point when there's no element
    before?: string; // type: the field's value before the edit (partial: the ≤ 120 chars just before the insertion)
    partial?: boolean; // type in a long text (> 280 chars): `value` is only the inserted span
    ts: number;
}

export type Op = "click" | "type" | "key" | "navigate" | "switch_app" | "sequence" | "goal";

export interface Action {
    op: Op;
    app: string;
    window?: string; // the window the step belongs to (sequences that cross windows)
    url?: string;
    targetId?: string;
    targetPath?: string; // resolved against the latest state of `app`
    value?: string; // text, option label (for selects), key name, url, or bundle id
    steps?: Action[]; // op === 'sequence'; run by the hub
    goal?: { ruleId: string; task: string; app?: string }; // op === 'goal': a rule matched; accepting makes `task` the aim (hub only)
    label: string; // pill text without the key glyph, e.g. "Click Checkout", "Repeat for ENG-150 · #13"
    confidence: number; // 0..1
    source: "pattern" | "model";
}

export interface Ghost {
    id: string;
    kind: "action" | "text" | "pay" | "blocked" | "done";
    label: string; // e.g. "Click Checkout ⇥", "Pay $0.30 · tickets.example ⇥"
    rect?: Rect; // highlight box
    cursor?: { x: number; y: number };
    pillAt?: { x: number; y: number }; // pill position when there is no rect
    ghostText?: string; // gray inline text for kind 'text'
    caret?: Rect; // a completion: draw only ghostText, right after this insertion point
    place?: "below" | "above" | "right" | "inside"; // pill placement relative to rect (default below)
    avoid?: Rect[]; // nearby elements the pill should not cover (when there's no `place`)
    ttlMs?: number; // auto-hide, used for 'done'
}

export interface Hud {
    mode: "idle" | "predicting" | "shown" | "running";
    lastSource?: "pattern" | "model";
    lastLatencyMs?: number;
    modelCalls: number;
    shown: number;
    accepted: number;
    tabDid: { clicks: number; keys: number }; // what Tab executed for the user
    youDid: number; // every real user input, including Tab/Esc presses
    lastTx?: { hash: string; explorerUrl: string; amountUsd: string };
    rules?: HudRule[]; // the user's rules, for the menu bar dropdown
    goal?: string; // a rule being carried out: what the ghosts are working toward
}

/** A rule as the menu bar dropdown lists it: what the user wrote, and whether it's on. */
export interface HudRule {
    id: string;
    text: string;
    enabled: boolean;
}

// ---- TabShell → hub ----
export type ShellToHub =
    | { type: "hello"; role: "shell" }
    | { type: "frontmost"; app: string; window: string }
    | ScreenState
    | UserEvent
    | { type: "icon_request"; items: { hash: string; png: string }[] } // crops of unlabeled icons (base64 PNG)
    | { type: "paused"; paused: boolean } // menu bar → Pause Tab
    | { type: "forget"; sinceMs: number } // menu bar → Forget the Last Hour
    | { type: "memory_search"; query: string } // menu bar → Search Memory
    | { type: "rule_add"; text: string } // menu bar dropdown → rules
    | { type: "rule_remove"; id: string }
    | { type: "rule_toggle"; id: string; enabled: boolean }
    | { type: "goal_clear" } // menu bar dropdown → Stop working toward a rule's goal
    | { type: "input"; kind: "key" | "click" }
    | { type: "accept"; ghostId: string }
    | { type: "dismiss"; ghostId: string }
    | ExecResult;

// ---- hub → TabShell ----
export type HubToShell =
    | { type: "ghost"; ghost: Ghost }
    | { type: "ghost_hide" }
    | { type: "exec"; ghostId: string; action: Action }
    | { type: "hud"; hud: Hud }
    | { type: "icon_labels"; items: { hash: string; label: string }[] } // "" = no usable name
    | { type: "memory_results"; query: string; results: MemoryHit[] };

/** A past task found by Search Memory: its one-line summary, where and when. */
export interface MemoryHit {
    ts: number; // when it ended
    app: string;
    summary: string;
    steps: number;
}

export interface ExecResult {
    type: "exec_result";
    ghostId: string; // sequence steps: "<ghostId>:<stepIndex>"
    ok: boolean;
    error?: string;
}

// ---- payment detector → hub ----
// A detector notices an HTTP 402 and holds the request; Tab checks it against the screen, asks the user, and pays.
export type DetectorToHub =
    | { type: "hello"; role: "payments" }
    | {
          type: "payment_required";
          paymentId: string;
          request: { url: string; method: string; headers: Record<string, string>; body?: string }; // body: base64
          responseHeaders: Record<string, string>; // the 402's headers (the x402 challenge is in `payment-required`)
          anchorRect?: Rect; // what the user clicked to get here
      }
    | { type: "payment_cancelled"; paymentId: string }; // the page went away

// ---- hub → payment detector ----
export type HubToDetector =
    // The paid response, to release the held request with (status/headers/body), or why it wasn't paid.
    | { type: "payment_done"; paymentId: string; ok: boolean; status?: number; headers?: Record<string, string>; body?: string; error?: string }
    | { type: "payment_declined"; paymentId: string }; // dismissed or blocked: let the 402 through
