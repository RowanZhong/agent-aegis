import os from "node:os";
import path from "node:path";
const DELETE_COMMANDS = new Set(["rm", "unlink", "rmdir", "trash", "remove-item", "del", "rd"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const MAX_LENGTH = 10_000;
/** Bounded lexical inspection only: never expand a glob, run a substitution or source a file. */
export function shellWords(input, groups = false) {
    const words = [], embedded = [];
    let parts = [], quote = "", started = false, substitutions = [];
    const add = (text, expand, glob) => {
        const previous = parts.at(-1);
        if (previous?.expand === expand && previous.glob === glob)
            previous.text += text;
        else
            parts.push({ text, expand, glob });
        started = true;
    };
    const flush = () => { if (started)
        words.push({ parts, embedded: substitutions }); parts = []; substitutions = []; started = false; };
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (quote === "'") {
            if (c === "'")
                quote = "";
            else
                add(c, false, false);
            continue;
        }
        if (c === "\\") {
            const next = input[++i];
            if (next === undefined)
                return;
            if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next))
                add("\\", false, false);
            if (next !== "\n")
                add(next, false, false);
            continue;
        }
        if (c === "`" || (c === "$" && input[i + 1] === "(")) {
            const backtick = c === "`", start = i + (backtick ? 1 : 2);
            let end = start, depth = 1;
            for (; end < input.length; end++) {
                if (input[end] === "\\") {
                    end++;
                    continue;
                }
                if (!backtick && input[end] === "(")
                    depth++;
                if ((backtick && input[end] === "`") || (!backtick && input[end] === ")" && --depth === 0))
                    break;
            }
            if (end === input.length)
                return;
            const code = input.slice(start, end);
            embedded.push(code);
            substitutions.push(code);
            add(/^\s*pwd\s*$/.test(code) ? "$PWD" : "$__AEGIS_UNRESOLVED_SUBSTITUTION", true, !quote);
            i = end;
            continue;
        }
        if (quote === '"') {
            if (c === '"')
                quote = "";
            else
                add(c, true, false);
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            started = true;
            continue;
        }
        if (c === "#" && !started) {
            while (i < input.length && input[i] !== "\n")
                i++;
            i--;
            continue;
        }
        if (c === "\n" || ";|&<>".includes(c) || groups && "()".includes(c)) {
            flush();
            let op = c === "\n" ? ";" : c;
            if (input[i + 1] === c && c !== "\n")
                op += input[++i];
            words.push({ parts: [], op });
            continue;
        }
        if (/\s/.test(c)) {
            flush();
            continue;
        }
        add(c, true, true);
        if (words.length > 512)
            return;
    }
    if (quote)
        return;
    flush();
    return { words, embedded };
}
export function expand(word, variables, cwd) {
    let unresolved = false, glob = false;
    const value = word.parts.map(part => {
        let text = part.text;
        if (part.expand) {
            text = text.replace(/\$\{([^}]+)\}|\$([A-Za-z_][\w]*)/g, (_all, braced, plain) => {
                const key = braced ?? plain;
                const value = variables.has(key) ? variables.get(key) : key === "PWD" ? cwd : key === "HOME" ? os.homedir() : undefined;
                if (value === undefined)
                    unresolved = true;
                return value ?? "";
            });
            if (text.includes("$"))
                unresolved = true;
            if (part.glob && /[*?\[{}]/.test(text))
                glob = true;
        }
        return text;
    }).join("");
    return { value: unresolved ? undefined : value, glob };
}
/** A whole-name glob at the root clears a whole class of root entries. Narrow suffix globs remain usable. */
export function bulkDeletionRoot(value) {
    const segments = value.split("/");
    const broad = (segment) => /^(?:\*{1,2}|\?\*|\*\?|\.\*|\.\[!\.\]\*|\.\.\?\*|\{\*,\.\*\})$/.test(segment);
    const index = segments.findIndex(broad);
    // */cache and **/*.tmp select named descendants, not the whole root.
    if (index < 0 || segments.slice(index).some(segment => segment && !broad(segment)))
        return;
    return segments.slice(0, index).join("/") || (value.startsWith("/") ? "/" : ".");
}
function withoutHeredocBodies(command) {
    // Bodies are stdin data, not subsequent shell commands. The existing inline/
    // obfuscation guard still owns interpreters that execute a heredoc as code.
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n/g;
    let match;
    while ((match = heredoc.exec(command))) {
        const start = heredoc.lastIndex;
        const ending = new RegExp(`^\\t*${match[2]}[ \\t]*(?:\\n|$)`, "m").exec(command.slice(start));
        if (!ending)
            return command.slice(0, start);
        command = command.slice(0, start) + command.slice(start + ending.index + ending[0].length);
        heredoc.lastIndex = start;
    }
    return command;
}
function matchesSimpleName(name, pattern) {
    // Only prove matches in the literal/*/? subset; other patterns are not
    // assumed to select the root just because their syntax is unfamiliar.
    if (/[\[\]{}\\]/.test(pattern))
        return false;
    let n = 0, p = 0, star = -1, retry = 0;
    while (n < name.length) {
        if (pattern[p] === "?" || pattern[p] === name[n]) {
            n++;
            p++;
        }
        else if (pattern[p] === "*") {
            star = p++;
            retry = n;
        }
        else if (star >= 0) {
            p = star + 1;
            n = ++retry;
        }
        else
            return false;
    }
    while (pattern[p] === "*")
        p++;
    return p === pattern.length;
}
export function inspectDeletionCommand(command, baseDir, depth = 0) {
    const result = { targets: [], uncertain: false };
    const deletionMention = /\b(?:rm|rmdir|unlink|trash|remove-item|rmtree|rmSync|rmdirSync|unlinkSync)\b|-(?:delete|exec)\b/i.test(command);
    if (command.length > MAX_LENGTH || depth > 3 || /[\0\r]/.test(command))
        return { ...result, uncertain: deletionMention };
    const lexed = shellWords(withoutHeredocBodies(command));
    if (!lexed)
        return { ...result, uncertain: deletionMention };
    const merge = (other) => { result.targets.push(...other.targets); result.uncertain ||= other.uncertain; };
    for (const code of lexed.embedded)
        merge(inspectDeletionCommand(code, baseDir, depth + 1));
    const variables = new Map();
    let cwd = baseDir;
    let segment = [];
    let preceding = ";";
    const visit = (separator) => {
        if (!segment.length)
            return;
        // Redirections are not operands. A separate command after them is still inspected.
        const raw = segment.map(word => word.parts.map(part => part.text).join(""));
        const args = segment.map(word => expand(word, variables, cwd));
        segment = [];
        const values = args.map(arg => arg.value);
        const conditional = preceding === "&&" || preceding === "||";
        preceding = separator;
        const assignments = [];
        while (/^[A-Za-z_]\w*=/.test(raw[0] ?? "")) {
            const key = raw.shift().split("=")[0];
            const value = values.shift()?.split(/=(.*)/s)[1];
            args.shift();
            assignments.push([key, conditional ? undefined : value]);
        }
        if (!values.length) {
            for (const [key, value] of assignments) {
                variables.set(key, value);
            }
            return;
        }
        let executable = path.basename(values[0] ?? "").toLowerCase();
        if (["source", ".", "eval", "read"].includes(executable)) {
            variables.clear();
            cwd = undefined;
            return;
        }
        if (["pushd", "popd"].includes(executable)) {
            cwd = undefined;
            return;
        }
        if (executable === "unset") {
            for (const value of values.slice(1))
                if (value)
                    variables.set(value, undefined);
            return;
        }
        if (executable === "export") {
            for (let i = 1; i < raw.length; i++)
                if (/^[A-Za-z_]\w*=/.test(raw[i])) {
                    const key = raw[i].split("=")[0];
                    variables.set(key, conditional ? undefined : values[i]?.split(/=(.*)/s)[1]);
                }
            return;
        }
        while (["env", "command", "exec", "sudo", "nohup"].includes(executable)) {
            if (executable === "command" && values.some(v => v === "-v" || v === "-V"))
                return;
            if (executable === "sudo" && values.some(v => v === "-l" || v === "--list"))
                return;
            values.shift();
            args.shift();
            while (values[0]?.startsWith("-") || /^[A-Za-z_]\w*=/.test(values[0] ?? "")) {
                const option = values.shift();
                args.shift();
                if (["-u", "-g", "-C", "--user", "--group", "--chdir", "--unset"].includes(option ?? "")) {
                    const value = values.shift();
                    args.shift();
                    if (option === "-C" || option === "--chdir")
                        cwd = value && cwd ? path.resolve(cwd, value) : undefined;
                }
            }
            executable = path.basename(values[0] ?? "").toLowerCase();
        }
        if (executable === "cd") {
            const target = values.filter(value => value !== "--")[1];
            // With ';' or '||', a failed cd leaves the previous directory in use.
            cwd = target && cwd && separator === "&&" && !args.some(a => a.glob)
                ? path.resolve(cwd, target.replace(/^~(?=$|\/)/, os.homedir())) : undefined;
            variables.set("PWD", cwd);
            return;
        }
        const target = (arg, filtered = false) => {
            if (arg.value === undefined || (!cwd && !path.isAbsolute(arg.value)))
                result.uncertain = true;
            else if (arg.value)
                result.targets.push({ value: arg.value, glob: arg.glob, baseDir: cwd ?? baseDir, filtered });
        };
        if (SHELLS.has(executable)) {
            const flag = values.findIndex((v, i) => i > 0 && /^-[a-z]*c$/.test(v ?? ""));
            if (flag >= 0 && values[flag + 1] !== undefined && cwd)
                merge(inspectDeletionCommand(values[flag + 1], cwd, depth + 1));
            else if (flag >= 0)
                result.uncertain = true;
            return;
        }
        if (DELETE_COMMANDS.has(executable) || (executable === "gio" && values[1] === "trash")) {
            const optionEnd = values.indexOf("--");
            if (values.slice(1, optionEnd < 0 ? undefined : optionEnd).some(v => v === "--help" || v === "--version"))
                return;
            let options = true;
            for (const arg of args.slice(executable === "gio" ? 2 : 1)) {
                if (options && arg.value === "--") {
                    options = false;
                    continue;
                }
                if (options && arg.value?.startsWith("-"))
                    continue;
                target(arg);
            }
            return;
        }
        if (executable === "find" && (values.includes("-delete") || values.some((v, i) => ["-exec", "-execdir"].includes(v ?? "") && DELETE_COMMANDS.has(path.basename(values[i + 1] ?? ""))))) {
            const roots = args.slice(1, values.findIndex((v, i) => i > 0 && (/^[-(!]/.test(v ?? ""))) || undefined);
            const filter = values.findIndex(v => ["-name", "-iname", "-path", "-ipath", "-wholename"].includes(v ?? ""));
            const pattern = values[filter + 1];
            const complex = values.some(v => ["-o", "-or", "!", "-not"].includes(v ?? ""));
            const metadataFilter = values.some(v => /^-(?:m|a|c)(?:time|min)$|^-(?:newer|size|empty|user|group|perm|regex|iregex)$/.test(v ?? ""));
            for (const arg of roots.length ? roots : [{ value: ".", glob: false }]) {
                const pathname = ["-path", "-ipath", "-wholename"].includes(values[filter] ?? "");
                const rootName = pathname ? arg.value ?? "." : path.basename(arg.value ?? ".");
                const insensitive = values[filter]?.startsWith("-i");
                const rootMatches = !!pattern && matchesSimpleName(insensitive ? rootName.toLowerCase() : rootName, insensitive ? pattern.toLowerCase() : pattern);
                const bulk = !!pattern && bulkDeletionRoot(pattern) !== undefined &&
                    (!pathname || [".", arg.value].includes(bulkDeletionRoot(pattern)));
                const filtered = !complex && (metadataFilter || (filter >= 0 && !!pattern && !bulk && !rootMatches));
                target(arg, filtered);
            }
            return;
        }
        if (/^(?:python(?:\d+(?:\.\d+)?)?|node|nodejs)$/.test(executable)) {
            const flag = values.findIndex((v, i) => i > 0 && ["-c", "-e", "--eval"].includes(v ?? ""));
            if (flag >= 0 && values[flag + 1] !== undefined) {
                const inline = inspectInlineDeletion(values[flag + 1], cwd);
                merge(inline);
            }
        }
    };
    let redirect = false;
    for (const word of lexed.words) {
        if (word.op?.includes(">") || word.op?.includes("<")) {
            redirect = true;
            continue;
        }
        if (word.op) {
            visit(word.op);
            redirect = false;
            continue;
        }
        if (redirect) {
            redirect = false;
            continue;
        }
        segment.push(word);
    }
    visit(";");
    return result;
}
/** Recognize a small straight-line subset with explicit filesystem imports and known paths.
 * Unsupported control flow, dynamic targets and unrelated functions do not create new refusals.
 * This is not a sandbox or a general-purpose interpreter.
 */
function inspectInlineDeletion(code, cwd) {
    const result = { targets: [], uncertain: false };
    const literals = [];
    const masked = code.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, text => {
        if (!['"', "'", "`"].includes(text[0]))
            return " ".repeat(text.length);
        const literal = text.slice(1, -1).replace(/\\x([0-9a-f]{2})|\\u([0-9a-f]{4})|\\([\\"'])/gi, (_all, hex, unicode, escaped) => escaped ?? String.fromCharCode(parseInt(hex ?? unicode, 16)));
        // Template/format strings may evaluate arbitrary expressions; do not treat them as paths.
        literals.push(text[0] === "`" && literal.includes("${") ? "" : literal);
        return `__AEGIS_STRING_${literals.length - 1}__`;
    });
    const variables = new Map();
    const bindings = new Map();
    const valueOf = (expression) => {
        const text = expression.trim();
        const literal = text.match(/^__AEGIS_STRING_(\d+)__$/);
        if (literal)
            return literals[Number(literal[1])];
        const fn = text.match(/^([\w.]+)\((.*)\)$/);
        if (fn) {
            const name = resolveName(fn[1]);
            if (["os.getcwd", "pathlib.Path.cwd", "process.cwd"].includes(name) && !fn[2])
                return cwd;
            if (name === "pathlib.Path" || fn[1] === "str")
                return valueOf(fn[2]);
        }
        return variables.get(text);
    };
    const resolveName = (name) => {
        const [first, ...rest] = name.split(".");
        return [bindings.get(first) ?? (first === "process" ? "process" : "?"), ...rest].join(".");
    };
    for (const raw of masked.split(/[;\n]/)) {
        const statement = raw.trim();
        if (!statement)
            continue;
        const imported = statement.match(/^import (shutil|os|pathlib)(?: as (\w+))?$/);
        if (imported) {
            bindings.set(imported[2] ?? imported[1], imported[1]);
            continue;
        }
        if (/^import (?:shutil|os|pathlib)(?:,\s*(?:shutil|os|pathlib))+$/.test(statement)) {
            for (const name of statement.slice(7).split(/,\s*/))
                bindings.set(name, name);
            continue;
        }
        const from = statement.match(/^from (shutil|os|pathlib) import (\w+)(?: as (\w+))?$/);
        if (from) {
            bindings.set(from[3] ?? from[2], `${from[1]}.${from[2]}`);
            continue;
        }
        const assignment = statement.match(/^(?:(?:const|let|var)\s+)?(\w+)\s*=\s*(.+)$/);
        if (assignment) {
            const require = assignment[2].match(/^require\((__AEGIS_STRING_\d+__)\)$/);
            const module = require ? valueOf(require[1]) : undefined;
            if (module === "fs" || module === "node:fs" || module === "fs/promises" || module === "node:fs/promises") {
                bindings.set(assignment[1], module.endsWith("/promises") ? "fs.promises" : "fs");
                variables.delete(assignment[1]);
                continue;
            }
            const value = valueOf(assignment[2]);
            bindings.delete(assignment[1]);
            variables.delete(assignment[1]);
            if (value !== undefined) {
                variables.set(assignment[1], value);
                continue;
            }
            // Dynamic state might also change cwd or module bindings; stop the analysis here.
            break;
        }
        const call = statement.match(/^(?:await\s+)?(require\(__AEGIS_STRING_\d+__\)\.\w+|[\w.]+)\((.*)\)$/);
        if (!call)
            break;
        let name = resolveName(call[1]);
        const require = call[1].match(/^require\((__AEGIS_STRING_\d+__)\)\.(\w+)$/);
        if (require && ["fs", "node:fs"].includes(valueOf(require[1]) ?? ""))
            name = `fs.${require[2]}`;
        if (!/^(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)|fs\.(?:promises\.)?(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync))$/.test(name))
            break;
        let depth = 0, end = 0;
        for (; end < call[2].length; end++) {
            const c = call[2][end];
            if (c === "," && depth === 0)
                break;
            if (c === "(")
                depth++;
            if (c === ")")
                depth--;
        }
        const value = valueOf(call[2].slice(0, end));
        if (value !== undefined && cwd)
            result.targets.push({ value, baseDir: cwd });
        else
            break;
    }
    return result;
}
