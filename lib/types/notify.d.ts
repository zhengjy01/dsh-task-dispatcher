/**
 * dsh-task-dispatcher — notify helpers.
 *
 * On each dispatch, notify the user that today's tasks are queued:
 *   - flomo: post one MEMO reusing the dsh-flomo credentials it already
 *     stores (~/.dsh/dsh-flomo.json). Reads the same file the flomo plugin
 *     uses (webhookUrl, or apiKey -> /api/prod/apis/webhook/v1/?apiKey=...),
 *     so no duplicate config is needed. Tags are appended as #tag.
 *   - macOS: post a Notification Center banner via osascript (best effort).
 *   - WeChat: hand the text to the local ClawBot gateway
 *     (DSH-WeChatClawBot, default http://127.0.0.1:51235), which relays it to
 *     the WeChat account that scanned the floating-ball QR code.
 *
 * All are best-effort: a delivery failure is reported in the returned
 * outcome, never thrown (dispatch must not fail because a notify failed).
 */
/** Shared flomo credential location: DSH_HOME when set, else ~/.dsh. */
export declare const FLOMO_CONFIG: string;
/**
 * Default ClawBot state directory — where the WeChat gateway keeps its login
 * (`accounts.json` plus `accounts/<botId>.json`, which carries the id of the
 * user who scanned). Mirrors the gateway's own `STATE_DIR` default;
 * `DSH_WECHAT_HOME` overrides it.
 */
export declare function wechatStateDir(override?: string): string;
/** Default ClawBot gateway endpoint (loopback HTTP API of the WeChat bridge). */
export declare const WECHAT_GATEWAY_URL = "http://127.0.0.1:51235";
/** Options for one WeChat notification. */
export interface WechatOptions {
    /** Gateway base URL; empty = {@link WECHAT_GATEWAY_URL}. */
    gatewayUrl?: string;
    /** Explicit recipient id; empty = auto-detect the ClawBot owner. */
    to?: string;
    /** ClawBot state dir; empty = `$DSH_WECHAT_HOME` or `~/.dsh-wechat`. */
    stateDir?: string;
}
/** Outcome of one notify channel. */
export interface NotifyResult {
    ok: boolean;
    channel: 'flomo' | 'mac' | 'wechat';
    message: string;
}
/**
 * Full-width number sign (U+FF03). It reads as a hash mark but is a different
 * code point from the ASCII '#', so flomo's tag parser — which matches
 * `#word` against an ASCII hash — never turns it into a tag.
 */
export declare const HASH_SAFE = "\uFF03";
/**
 * Replace every ASCII '#' in a memo body with the full-width '＃'.
 *
 * flomo parses `#word` as a tag, so a raw '#' inside body text (a task title
 * like `做A #重要`, a PR number like `#91`, a markdown heading) leaks into the
 * tag set. Replacing rather than deleting keeps the text readable — `#91`
 * survives as `＃91`. The configured flomoTag is appended separately by
 * buildFlomoContent and keeps its own ASCII '#'.
 */
export declare function escapeHashes(value: string): string;
/** Append #tags (space-separated) to a memo body, mirroring dsh-flomo. */
export declare function buildFlomoContent(content: string, tags: string): string;
/**
 * Post one MEMO to flomo. Returns an outcome, never throws.
 *
 * `escapeBodyHashes` (default true) is the single choke point that keeps every
 * path into flomo free of a stray ASCII '#': the body is escaped *before* the
 * #tag suffix is appended, so the tag keeps its hash while the body has none.
 */
export declare function flomoMemo(content: string, tags: string, escapeBodyHashes?: boolean): Promise<NotifyResult>;
/**
 * Resolve the WeChat recipient (iLink `to_user_id`) for a ClawBot message.
 *
 * Order: explicit `to` option → the `userId` recorded by the ClawBot gateway
 * when the user scanned the floating-ball QR code. The gateway stores it in
 * `<stateDir>/accounts/<botId>.json` (`userId: <wxid>@im.wechat`) and lists the
 * bot ids in `<stateDir>/accounts.json`. Returns '' when ClawBot has never been
 * logged in on this machine.
 */
export declare function wechatRecipient(opts?: WechatOptions): Promise<string>;
/**
 * Send one text message to the user's WeChat through the ClawBot gateway.
 *
 * The gateway is a local loopback service started by the DSH-WeChatClawBot
 * plugin; this plugin never talks to WeChat directly and stores no WeChat
 * credentials. Returns an outcome, never throws — a missing gateway or a
 * missing ClawBot login is reported as a failed channel, not an exception.
 */
export declare function wechatSend(text: string, opts?: WechatOptions): Promise<NotifyResult>;
/** Post a macOS Notification Center banner. Never throws. */
export declare function macNotify(title: string, subtitle: string, body: string): Promise<NotifyResult>;
