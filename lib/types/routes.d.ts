/**
 * dsh-task-dispatcher — loopback HTTP routes for the web settings panel.
 *
 * Route family: /api/dsh-task-dispatcher/*. All routes are loopback-only
 * (127.0.0.1/localhost, same-origin) — the settings panel is the only
 * consumer.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DispatcherStore } from './store.ts';
import type { TickTickApi } from 'dsh-ticktick';
/** Route paths. */
export declare const DISPATCHER_API: {
    readonly config: "/api/dsh-task-dispatcher/config";
    readonly status: "/api/dsh-task-dispatcher/status";
    readonly run: "/api/dsh-task-dispatcher/run";
    readonly workspaces: "/api/dsh-task-dispatcher/workspaces";
};
/** Route handler context. */
export interface RouteContext {
    store: DispatcherStore;
    api: TickTickApi;
}
/** Build every /api/dsh-task-dispatcher route (exact paths). */
export declare function makeRoutes(deps: RouteContext): ({
    kind: "exact";
    path: "/api/dsh-task-dispatcher/config";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-task-dispatcher/status";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-task-dispatcher/run";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-task-dispatcher/workspaces";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
})[];
