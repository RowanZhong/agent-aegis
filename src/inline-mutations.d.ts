import type { Mutation } from "./config-mutations.js";
/** Only straight-line, explicitly bound filesystem calls. Never evaluate code.
 * Unknown control flow / rebinding ends inspection instead of guessing effects.
 */
export declare function inlineMutations(code: string, language: "python" | "node", cwd: string, environment: Map<string, string | undefined>): Mutation[];
