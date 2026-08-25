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
/** Append #tags (space-separated) to a memo body, mirroring dsh-flomo. */
export declare function buildFlomoContent(content: string, tags: string): string;
/** Post one MEMO to flomo. Returns an outcome, never throws. */
export declare function flomoMemo(content: string, tags: string): Promise<NotifyResult>;
/** Post a macOS Notification Center banner. Never throws. */
export declare function macNotify(title: string, subtitle: string, body: string): Promise<NotifyResult>;
