// Coordinates: global screen points, origin = top-left of the main display (AX convention).
export type Rect = { x: number; y: number; w: number; h: number };

export type Role =
    | "button"
    | "link"
    | "textfield"
    | "textarea"
    | "select"
    | "checkbox"
    | "text"
    // v2, from AXSensor (any app)
    | "cell"
    | "row"
    | "menuitem"
    | "tab"
    | "slider"
    | "image"
    | "other";

export interface El {
    id: string; // stable across snapshots where possible
    role: Role;
    label: string; // accessible name or visible text, ≤ 80 chars
    value?: string; // current value (fields); for Terminal, the last 40 lines
    options?: string[]; // role 'select' only: option labels
    checked?: boolean; // checkboxes and pressed toggle buttons
    rect: Rect;
    enabled: boolean;
    path?: string; // CSS path for web. Replays resolve targets by path.
    radius?: number; // web: corner radius in points (CSS border-radius, top-left), at most min(w, h) / 2; 0 = square
    list?: { key: string; index: number; field?: string }; // item in a repeated structure; field = path relative to the item
    // v2 (AXSensor, any app); all optional
    section?: string; // nearest labelled container, e.g. "Shipping address"
    axId?: string; // AXIdentifier
    placeholder?: string;
    help?: string;
    focused?: boolean;
    secure?: boolean; // password field: never carries a value
    grid?: { row: number; col?: number }; // table cell / row position
    caret?: Rect; // insertion point of the focused text field
}

export interface ScreenState {
    type: "state";
    source: "native" | "web" | "ax"; // native = Terminal reader; ax = any app via Accessibility (v2)
    app: string; // bundle id: 'com.google.Chrome' for web, e.g. 'com.apple.Terminal' for native
    window: string;
    url?: string;
    focused: boolean; // web: this tab is in the focused Chrome window. native: always true
    elements: El[]; // visible only, ≤ 200, interactive first, then text
    seq: number; // monotonic per source
    ts: number;
    nodes?: number; // ax: AX nodes walked (diagnostics)
}

export interface UserEvent {
    // web (C) or native (A's ActionObserver, any app). A also sends anonymous `input` messages for the HUD counters.
    type: "user_event";
    source: "web" | "native";
    app: string;
    url?: string;
    window?: string; // native
    kind: "click" | "type" | "key" | "focus" | "navigate";
    target?: El;
    value?: string; // committed text or selected option label, key name ("cmd+s", "Return"), or url
    before?: string; // native type: the field's value before the edit (partial: the ≤120 chars just before the insertion)
    partial?: boolean; // native type in a long text (> 280 chars): `value` is only the inserted span
    ts: number;
}

export type Op = "click" | "type" | "key" | "navigate" | "switch_app" | "sequence";

export interface Action {
    op: Op;
    app: string;
    url?: string; // web: the page this step belongs to, so C can pick the right tab
    targetId?: string; // id in the latest state of `app`
    targetPath?: string; // used by replays; resolved against the latest state
    value?: string; // text, option label (for selects), key name, url, or bundle id
    steps?: Action[]; // op === 'sequence'; run by the hub only
    label: string; // pill text without the key glyph, e.g. "Click Checkout", "Repeat for ENG-150 · #13"
    confidence: number; // 0..1
    source: "pattern" | "model";
}

export interface Ghost {
    id: string;
    kind: "action" | "text" | "pay" | "blocked" | "done";
    label: string; // e.g. "Click Checkout ⇥", "Pay $0.30 · tickets.localhost ⇥"
    rect?: Rect; // highlight box; omitted for Terminal ghosts
    cursor?: { x: number; y: number };
    pillAt?: { x: number; y: number }; // pill position when there is no rect
    ghostText?: string; // gray inline text for kind 'text'
    place?: "below" | "above" | "right" | "inside"; // pill placement relative to rect (default below; A flips it above at the screen edge)
    radius?: number; // the target's corner radius (El.radius): A draws the highlight concentric with the element's shape
    avoid?: Rect[]; // other elements near rect; with no `place`, A puts an action/text pill where it covers none of them (pay/blocked stay below)
    ttlMs?: number; // auto-hide, used for 'done'
    dockApp?: string; // STRETCH: a cross-app offer anchors on this bundle id's Dock icon (A resolves the rect; falls back to pillAt)
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
}

export interface PaymentRequired {
    type: "payment_required";
    paymentId: string;
    url: string;
    method: string;
    payeeDomain: string; // hostname shown to the user
    payTo: string;
    amountUsd: string; // "0.30"
    network: string; // "eip155:84532"
    asset: string;
    verdict: { ok: boolean; reason?: string; pagePriceUsd?: string };
    anchorRect?: Rect; // element that triggered it (screen points)
}

export interface PaymentResult {
    type: "payment_result";
    paymentId: string;
    ok: boolean;
    txHash?: string;
    explorerUrl?: string;
    error?: string;
}

// ---- Messages (see PLAN.md "Messages"). Every message has a `type` field. ----

export type AppId = string; // bundle id

// A → hub
export type ShellToHub =
    | { type: "hello"; role: "shell" }
    | { type: "frontmost"; app: AppId; window: string }
    | ScreenState // native (Terminal) or ax (any app)
    | UserEvent // native: resolved actions in any app
    | { type: "icon_request"; items: { hash: string; png: string }[] } // crops of unlabeled icons (base64 PNG)
    | { type: "input"; kind: "key" | "click" }
    | { type: "accept"; ghostId: string }
    | { type: "dismiss"; ghostId: string }
    | ExecResult
    | { type: "hud_click"; item: "ledger" | "contrast" };

// hub → A
export type HubToShell =
    | { type: "ghost"; ghost: Ghost }
    | { type: "ghost_hide" }
    | { type: "exec"; ghostId: string; action: Action } // switch_app only
    | { type: "hud"; hud: Hud }
    | { type: "icon_labels"; items: { hash: string; label: string }[] }; // "" = no usable name

// C → hub
export type WebToHub =
    | { type: "hello"; role: "web" }
    | ScreenState // web
    | UserEvent
    | PaymentRequired
    | PaymentResult
    | ExecResult;

// hub → C
export type HubToWeb =
    | { type: "exec"; ghostId: string; action: Action } // single step
    | { type: "pay"; paymentId: string }
    | { type: "dismiss_payment"; paymentId: string }
    | { type: "open_url"; url: string };

export interface ExecResult {
    type: "exec_result";
    ghostId: string; // sequence steps: "<ghostId>:<stepIndex>"
    ok: boolean;
    error?: string;
}

export type AnyMessage = ShellToHub | HubToShell | WebToHub | HubToWeb;
