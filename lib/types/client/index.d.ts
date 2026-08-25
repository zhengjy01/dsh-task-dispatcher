import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Required services. */
export declare const inject: string[];
/**
 * Register the dispatcher settings page.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
