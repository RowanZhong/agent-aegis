import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expand, shellWords } from "./deletion-targets.js";
import { inlineMutations } from "./inline-mutations.js";
export const CONTROL_CONFIG_FILES = ["mcp-servers.json5", "agents-list.json5"];
const text = (value) => typeof value === "string" && value ? value : undefined;
const raw = (word) => word.parts.map(p => p.text).join("");
const isWithin = (file, dir) => file === dir || file.startsWith(dir + path.sep);
/** Resolve existing ancestors too (the protected file need not exist yet). */
function canonical(file) {
    let parent = file;
    const missing = [];
    for (let i = 0; i < 128; i++) {
        try {
            return path.join(fs.realpathSync(parent), ...missing);
        }
        catch { /* missing leaf */ }
        const next = path.dirname(parent);
        if (next === parent)
            break;
        missing.unshift(path.basename(parent));
        parent = next;
    }
    return file;
}
const entryPath = (file) => path.join(canonical(path.dirname(file)), path.basename(file));
const absolute = (value, cwd) => path.resolve(cwd, value);
const directPath = (value, cwd) => absolute(value.replace(/^~(?=$|\/)/, os.homedir()), cwd);
export function mutationMatches(mutation, assets) {
    const entry = entryPath(mutation.path);
    const target = mutation.kind === "write" ? canonical(mutation.path) : entry;
    return assets.some(asset => {
        const protectedEntry = entryPath(asset), protectedTarget = canonical(asset);
        // Removing an unrelated symlink does not delete its referent. Replacing the
        // configured path itself, including a configured symlink, still changes it.
        return entry === protectedEntry || target === protectedTarget ||
            (!!mutation.tree && isWithin(protectedEntry, target));
    });
}
function heredocSubstitutions(body) {
    const result = [];
    // In an unquoted heredoc, quote characters are data; only backslash can
    // suppress a substitution. Quotes inside $(...) regain shell semantics.
    for (let i = 0; i < body.length; i++) {
        if (body[i] === "\\" && /[$`\\\n]/.test(body[i + 1] ?? "")) {
            i++;
            continue;
        }
        const tick = body[i] === "`";
        if (!tick && body.slice(i, i + 2) !== "$(")
            continue;
        const start = i + (tick ? 1 : 2);
        let depth = 1, quote = "", end = start;
        for (; end < body.length; end++) {
            const c = body[end];
            if (c === "\\") {
                end++;
                continue;
            }
            if (tick) {
                if (c === "`")
                    break;
                continue;
            }
            if (quote) {
                if (c === quote)
                    quote = "";
                continue;
            }
            if (c === "'" || c === '"') {
                quote = c;
                continue;
            }
            if (c === "(")
                depth++;
            if (c === ")" && --depth === 0)
                break;
        }
        if (end < body.length) {
            result.push(body.slice(start, end));
            i = end;
        }
    }
    return result;
}
function heredocs(command) {
    const lines = command.split("\n"), bodies = [];
    let code = "", header = "";
    for (let i = 0; i < lines.length; i++) {
        header += lines[i] + "\n";
        const lexed = shellWords(header, true);
        if (!lexed)
            continue; // A multiline quoted string is still one shell word.
        code += header;
        header = "";
        for (let j = 0; j < lexed.words.length; j++) {
            if (lexed.words[j].op !== "<<")
                continue;
            const word = lexed.words[++j];
            if (!word || word.op)
                continue;
            const label = raw(word), stripTabs = label.startsWith("-");
            const delimiter = stripTabs ? label.slice(1) : label;
            if (!delimiter)
                continue;
            const body = [];
            while (++i < lines.length) {
                const line = stripTabs ? lines[i].replace(/^\t+/, "") : lines[i];
                if (line === delimiter)
                    break;
                body.push(line);
            }
            bodies.push({ delimiter: label, code: body.join("\n"), quoted: word.parts.some(p => !p.expand) });
        }
    }
    return { code: code + header, bodies };
}
/** Bounded, non-executing inspection. Unknown expressions do not become targets. */
export function shellMutations(command, baseDir, environment = new Map(), depth = 0) {
    if (command.length > 32_768 || depth > 3 || /[\0\r]/.test(command))
        return [];
    const prepared = heredocs(command), lexed = shellWords(prepared.code, true);
    if (!lexed)
        return [];
    const result = [], vars = new Map(environment);
    let cwd = baseDir, segment = [], preceding = ";";
    const value = (word) => {
        const resolved = expand(word, vars, cwd);
        if (resolved.glob)
            return undefined;
        // Shell tilde expansion only applies to an unquoted leading tilde.
        if (!word.parts[0]?.glob)
            return resolved.value;
        let expanded = resolved.value?.replace(/^~(?=$|\/)/, os.homedir());
        if (/^[A-Za-z_]\w*=~(?=$|\/)/.test(word.parts[0].text))
            expanded = expanded?.replace(/=~(?=$|\/)/, "=" + os.homedir());
        return expanded;
    };
    const add = (p, kind, tree = false) => {
        if (p && (cwd || path.isAbsolute(p)))
            result.push({ path: absolute(p, cwd ?? baseDir), kind, tree });
    };
    const recurse = (code, childEnv = vars) => {
        if (cwd)
            result.push(...shellMutations(code, cwd, childEnv, depth + 1));
    };
    const visit = (separator) => {
        if (!segment.length) {
            preceding = separator;
            return;
        }
        const words = segment;
        segment = [];
        for (const word of words)
            for (const code of word.embedded ?? [])
                recurse(code);
        const args = [], source = [];
        let stdin;
        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            if (word.op && /[<>]/.test(word.op)) {
                let op = word.op;
                if (words[i + 1]?.op === "&" || words[i + 1]?.op === "|") {
                    op += words[++i].op;
                }
                if (word.op === "<" && words[i + 1]?.op === ">") {
                    op = "<>";
                    i++;
                }
                const dest = words[++i];
                if (!dest || dest.op)
                    continue;
                if (op === "<<") {
                    stdin = prepared.bodies.shift();
                    if (stdin && !stdin.quoted)
                        for (const code of heredocSubstitutions(stdin.code))
                            recurse(code);
                    continue;
                }
                if (op.includes(">")) {
                    const p = value(dest);
                    if (!(op.endsWith("&") && /^(?:\d+|-)$/.test(p ?? "")))
                        add(p, "write");
                }
                continue;
            }
            source.push(word);
            args.push(value(word));
        }
        const childEnv = new Map(vars), assignments = [];
        while (/^[A-Za-z_]\w*=/.test(raw(source[0] ?? { parts: [] }))) {
            const key = raw(source.shift()).split("=")[0];
            const v = args.shift()?.split(/=(.*)/s)[1];
            assignments.push([key, v]);
            childEnv.set(key, v);
        }
        if (!args.length) {
            for (const [k, v] of assignments)
                vars.set(k, ["&&", "||"].includes(preceding) ? undefined : v);
            preceding = separator;
            return;
        }
        const conditional = ["&&", "||"].includes(preceding);
        preceding = separator;
        let exe = path.basename(args.shift() ?? "");
        while (["env", "command", "exec", "sudo", "nohup"].includes(exe)) {
            if (exe === "command" && args.some(v => v === "-v" || v === "-V"))
                return;
            if (exe === "sudo" && args.some(v => v === "-l" || v === "--list"))
                return;
            while (args[0]?.startsWith("-") || /^[A-Za-z_]\w*=/.test(args[0] ?? "")) {
                const option = args.shift();
                if (/^[A-Za-z_]\w*=/.test(option)) {
                    const split = option.indexOf("=");
                    childEnv.set(option.slice(0, split), option.slice(split + 1));
                }
                else if (["-u", "--unset", "-g", "--user", "--group", "-C", "--chdir"].includes(option)) {
                    const v = args.shift();
                    if (option === "-C" || option === "--chdir")
                        cwd = v && cwd ? absolute(v, cwd) : undefined;
                    else if (v && (option === "-u" || option === "--unset"))
                        childEnv.set(v, undefined);
                }
            }
            exe = path.basename(args.shift() ?? "");
        }
        if (exe === "cd") {
            const v = args.filter(v => v !== "--")[0];
            cwd = v && cwd && separator === "&&" ? absolute(v, cwd) : undefined;
            vars.set("PWD", cwd);
            return;
        }
        if (["source", ".", "eval", "read", "pushd", "popd", "if", "then", "else", "elif", "for", "while", "until", "case", "function"].includes(exe)) {
            for (const k of vars.keys())
                vars.set(k, undefined);
            vars.set("HOME", undefined);
            vars.set("PWD", undefined);
            cwd = undefined;
            return;
        }
        if (exe === "unset") {
            for (const k of args)
                if (k)
                    vars.set(k, undefined);
            return;
        }
        if (exe === "export") {
            for (const a of args)
                if (a && /^[A-Za-z_]\w*=/.test(a)) {
                    const i = a.indexOf("=");
                    vars.set(a.slice(0, i), conditional ? undefined : a.slice(i + 1));
                }
            return;
        }
        if (["sh", "bash", "zsh", "dash", "ksh"].includes(exe)) {
            const flag = args.findIndex(v => /^-[a-z]*c$/.test(v ?? ""));
            if (flag >= 0 && args[flag + 1] !== undefined)
                recurse(args[flag + 1], childEnv);
            else if (stdin?.quoted)
                recurse(stdin.code, childEnv);
            return;
        }
        if (/^(?:python(?:\d+(?:\.\d+)?)?|node|nodejs)$/.test(exe)) {
            const flag = args.findIndex(v => ["-c", "-e", "--eval"].includes(v ?? ""));
            const code = flag >= 0 ? args[flag + 1] : stdin?.code;
            if (code !== undefined && cwd && (flag >= 0 || stdin?.quoted || !/[\$`\\]/.test(code)))
                result.push(...inlineMutations(code, exe.startsWith("python") ? "python" : "node", cwd, childEnv));
            return;
        }
        let options = true;
        const operands = [], flags = [];
        let directory, sedScript = false;
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a === undefined)
                return;
            if (options && a === "--") {
                options = false;
                continue;
            }
            if (options && a.startsWith("-")) {
                if (a === "--help" || a === "--version")
                    return;
                flags.push(a);
                if ((exe === "touch" && ["-r", "--reference", "-d", "--date", "-t"].includes(a)) ||
                    (exe === "truncate" && ["-r", "--reference", "-s", "--size"].includes(a))) {
                    i++;
                    continue;
                }
                if (exe === "sed" && ["-e", "--expression", "-f", "--file"].includes(a)) {
                    i++;
                    sedScript = true;
                    continue;
                }
                if (exe === "sed" && /^(?:-[ef].+|--(?:expression|file)=)/.test(a)) {
                    sedScript = true;
                    continue;
                }
                if (exe === "sed" && a === "-i" && args[i + 1] === "") {
                    i++;
                    continue;
                }
                if (["-t", "--target-directory"].includes(a))
                    directory = args[++i];
                else if (a.startsWith("--target-directory="))
                    directory = a.slice(19);
                else if (["--suffix", "-S"].includes(a))
                    i++;
                continue;
            }
            operands.push(a);
        }
        if (["tee", "truncate", "touch"].includes(exe))
            for (const p of operands)
                add(p, "write");
        if (["rm", "unlink", "rmdir", "trash"].includes(exe))
            for (const p of operands)
                add(p, "remove", flags.some(f => /^-[^-]*[rR]/.test(f) || f === "--recursive") || exe === "trash");
        if (exe === "sed" && flags.some(f => f === "--in-place" || f.startsWith("--in-place=") || /^-[^-]*i/.test(f)))
            for (const p of operands.slice(sedScript ? 0 : 1))
                add(p, "replace");
        if (["cp", "mv", "install"].includes(exe)) {
            const dest = directory ?? operands.pop();
            if (!dest)
                return;
            let destIsDir = directory !== undefined;
            try {
                destIsDir ||= fs.statSync(absolute(dest, cwd ?? baseDir)).isDirectory();
            }
            catch { /* absent destination */ }
            if (flags.includes("-T") || flags.includes("--no-target-directory"))
                destIsDir = false;
            for (const src of operands) {
                if (exe === "mv")
                    add(src, "remove", true);
                const target = destIsDir ? path.join(dest, path.basename(src)) : dest;
                add(target, exe === "mv" || flags.includes("--remove-destination") ? "replace" : "write", exe === "mv");
                // Recursive copy merges an existing source tree; inspect only the known
                // protected basename, never enumerate or read arbitrary directory trees.
                if (exe !== "mv" && flags.some(f => /^-[^-]*[rRa]/.test(f) || f === "--recursive")) {
                    const source = absolute(src, cwd ?? baseDir);
                    for (const name of CONTROL_CONFIG_FILES) {
                        const child = path.join(source, name);
                        try {
                            if (fs.statSync(child).isFile())
                                add(path.join(src.endsWith("/.") ? dest : target, name), "write");
                        }
                        catch { /* no such source */ }
                    }
                }
            }
        }
    };
    const scopes = [];
    for (let i = 0; i < lexed.words.length; i++) {
        const word = lexed.words[i];
        if (word.op === "(") {
            visit(";");
            scopes.push({ cwd, vars: new Map(vars) });
            continue;
        }
        if (word.op === ")") {
            visit(";");
            const scope = scopes.pop();
            if (scope) {
                cwd = scope.cwd;
                vars.clear();
                for (const [k, v] of scope.vars)
                    vars.set(k, v);
            }
            continue;
        }
        if (word.op && [";", "&&", "||", "|", "&"].includes(word.op) && !/[<>]/.test(segment.at(-1)?.op ?? ""))
            visit(word.op);
        else
            segment.push(word);
    }
    visit(";");
    return result;
}
export function resolveConfigMutations(tool, params, baseDir) {
    // Only command tools consume workdir. File tools resolve against their
    // host-bound workspace even if an unknown workdir argument is supplied.
    const cwd = (tool === "exec" || tool === "bash") && text(params.workdir) ? directPath(text(params.workdir), baseDir) : baseDir;
    if (tool === "exec" || tool === "bash") {
        const command = text(params.command) ?? text(params.cmd);
        const environment = new Map();
        for (const k of ["HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"])
            if (process.env[k])
                environment.set(k, process.env[k]);
        if (params.env && typeof params.env === "object")
            for (const [k, v] of Object.entries(params.env))
                environment.set(k, typeof v === "string" ? v : undefined);
        return command ? shellMutations(command, cwd, environment) : [];
    }
    if (tool === "apply_patch") {
        const patch = text(params.input) ?? text(params.patch) ?? text(params.patchText) ?? "";
        const mutations = [];
        let state = "header", moveAllowed = false;
        for (const line of patch.split(/\r?\n/)) {
            if (state === "add" && line.startsWith("+"))
                continue;
            if (state === "update") {
                const move = moveAllowed ? line.trim().match(/^\*\*\* Move to: (.+)$/) : undefined;
                moveAllowed = false;
                if (move) {
                    mutations.push({ path: directPath(move[1], cwd), kind: "replace" });
                    continue;
                }
                // Leading spaces inside update chunks are unchanged file contents,
                // whereas a header at a hunk boundary is trimmed by the native parser.
                if (!line.startsWith("***"))
                    continue;
            }
            const m = line.trim().match(/^\*\*\* (Add File|Update File|Delete File): (.+)$/);
            if (!m) {
                state = "header";
                continue;
            }
            mutations.push({ path: directPath(m[2], cwd), kind: m[1] === "Delete File" ? "remove" : "write" });
            state = m[1] === "Add File" ? "add" : m[1] === "Update File" ? "update" : "header";
            moveAllowed = state === "update";
        }
        return mutations;
    }
    const p = text(params.path) ?? text(params.file_path) ?? text(params.filePath);
    if (!p)
        return [];
    if (["write", "edit"].includes(tool))
        return [{ path: directPath(p, cwd), kind: "write" }];
    if (["delete", "remove", "unlink", "rmdir", "trash"].includes(tool))
        return [{ path: directPath(p, cwd), kind: "remove", tree: tool !== "unlink" }];
    return [];
}
