/**
 * dsh-task-dispatcher — notify helpers.
 *
 * On each dispatch, notify the user that today's tasks are queued:
 *   - flomo: post one MEMO reusing the dsh-flomo credentials it already
 *     stores (~/.dsh/dsh-flomo.json). Reads the same file the flomo plugin
 *     uses (webhookUrl, or apiKey -> /api/prod/apis/webhook/v1/?apiKey=...),
 *     so no duplicate config is needed. Tags are appended as #tag.
 *   - macOS: post a Notification Center banner via osascript (best effort).
 *
 * Both are best-effort: a delivery failure is reported in the returned
 * outcome, never thrown (dispatch must not fail because a notify failed).
 */
/** Default flomo credential location (mirrors the dsh-flomo plugin). */
export declare const FLOMO_CONFIG: string;
/** Outcome of one notify channel. */
export interface NotifyResult {
    ok: boolean;
    channel: 'flomo' | 'mac';
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
/** Post a macOS Notification Center banner. Never throws. */
export declare function macNotify(title: string, subtitle: string, body: string): Promise<NotifyResult>;
