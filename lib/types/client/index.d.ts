import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** Required services. */
export declare const inject: string[];
/**
 * Register the dispatcher settings page.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
