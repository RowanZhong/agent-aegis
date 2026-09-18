import { INLINE_EXEC_TEXT_MAX_CHARS } from "./config.js";
/** Recognize a tiny complete-command grammar, not arbitrary JS/Python safety.
 * POSIX single quotes preserve the program verbatim. Double-quoted shell code,
 * expansions, redirections, pipelines, extra arguments/statements and prefixes
 * cannot match. Only one JSON string literal may be passed to the print call.
 * Never evaluate input. Unknown syntax stays on the existing guard path.
 */
export function isLiteralPrintCommand(command) {
    if (command.length > INLINE_EXEC_TEXT_MAX_CHARS || /[\r\n\u2028\u2029\0]/u.test(command))
        return false;
    const shell = command.match(/^[ \t]*((?:\/[A-Za-z0-9_.-]+)*\/?(?:node|python(?:\d+(?:\.\d+)?)?))[ \t]+(-e|-c)[ \t]+'([^']*)'[ \t]*$/);
    if (!shell)
        return false;
    const node = shell[1].split("/").at(-1) === "node";
    if (shell[2] !== (node ? "-e" : "-c"))
        return false;
    const program = shell[3].trim();
    const call = program.match(node
        ? /^console\.log[ \t]*\((.*)\)[ \t]*;?$/
        : /^print[ \t]*\((.*)\)[ \t]*;?$/);
    if (!call)
        return false;
    const argument = call[1].trim();
    if (!argument.startsWith('"') || !argument.endsWith('"'))
        return false;
    try {
        return typeof JSON.parse(argument) === "string";
    }
    catch {
        return false;
    }
}
