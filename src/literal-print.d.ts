/** Recognize a tiny complete-command grammar, not arbitrary JS/Python safety.
 * POSIX single quotes preserve the program verbatim. Double-quoted shell code,
 * expansions, redirections, pipelines, extra arguments/statements and prefixes
 * cannot match. Only one JSON string literal may be passed to the print call.
 * Never evaluate input. Unknown syntax stays on the existing guard path.
 */
export declare function isLiteralPrintCommand(command: string): boolean;
