import { type DwsCommand } from "./command.js";
import type { Identity } from "./events.js";
/** Abstract interpretation of a deliberately small Python subset, never execution.
 * Unknown control flow, mutation, calls and parse errors abstain for the whole file.
 */
export declare function analyzeScript(code: string, language: "python" | "shell", stdin: DwsCommand | undefined, identity: (command: DwsCommand) => Identity | undefined, deadline: number): "match" | "clear" | "unsupported_syntax" | "budget_exceeded";
