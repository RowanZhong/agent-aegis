import os from "node:os";
import path from "node:path";
const string = (v) => v && (v.kind === "string" || v.kind === "path") ? v.value : undefined;
/** Only straight-line, explicitly bound filesystem calls. Never evaluate code.
 * Unknown control flow / rebinding ends inspection instead of guessing effects.
 */
export function inlineMutations(code, language, cwd, environment) {
    const result = [], literals = [], vars = new Map();
    if (code.length > 32_768)
        return result;
    let masked = "";
    for (let i = 0; i < code.length; i++) {
        const c = code[i];
        if ((language === "python" && c === "#") || (language === "node" && code.slice(i, i + 2) === "//")) {
            while (i < code.length && code[i] !== "\n")
                i++;
            masked += "\n";
            continue;
        }
        if (language === "node" && code.slice(i, i + 2) === "/*") {
            const end = code.indexOf("*/", i + 2);
            if (end < 0)
                return result;
            i = end + 1;
            masked += " ";
            continue;
        }
        if (!["'", '"', "`"].includes(c)) {
            masked += c;
            continue;
        }
        let value = "", valid = true, closed = false;
        for (i++; i < code.length; i++) {
            if (code[i] === c) {
                closed = true;
                break;
            }
            if (c === "`" && code.slice(i, i + 2) === "${")
                valid = false;
            if (code[i] !== "\\") {
                value += code[i];
                continue;
            }
            const next = code[++i], simple = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"', "`": "`" };
            if (next in simple)
                value += simple[next];
            else if (["x", "u"].includes(next)) {
                const n = next === "x" ? 2 : 4, hex = code.slice(i + 1, i + 1 + n);
                if (new RegExp(`^[0-9a-f]{${n}}$`, "i").test(hex)) {
                    value += String.fromCharCode(parseInt(hex, 16));
                    i += n;
                }
                else
                    valid = false;
            }
            else
                valid = false;
        }
        if (!closed)
            return result;
        literals.push(valid ? value : undefined);
        masked += `@${literals.length - 1}@`;
    }
    const split = (s, separator) => {
        let nesting = 0, start = 0;
        const parts = [];
        for (let i = 0; i < s.length; i++) {
            if ("([{".includes(s[i]))
                nesting++;
            if (")]}".includes(s[i]))
                nesting--;
            if (nesting === 0 && separator.includes(s[i])) {
                parts.push(s.slice(start, i));
                start = i + 1;
            }
        }
        parts.push(s.slice(start));
        return parts;
    };
    const add = (p, kind, tree = false) => { const v = string(p); if (v)
        result.push({ path: path.resolve(cwd, v), kind, tree }); };
    const home = () => environment.has("HOME") ? environment.get("HOME") : os.homedir();
    const name = (value) => ({ kind: "name", value });
    const literal = (value) => value === undefined ? undefined : { kind: "string", value };
    let steps = 0, unknownCall = false;
    function evaluate(expression, depth = 0) {
        if (++steps > 2048 || depth > 16)
            return;
        const s = expression.trim().replace(/^await\s+/, "");
        const lit = s.match(/^@(\d+)@$/);
        if (lit)
            return literal(literals[Number(lit[1])]);
        if (vars.has(s))
            return vars.get(s);
        const plus = split(s, "+");
        if (plus.length > 1) {
            const pieces = plus.map(p => string(evaluate(p, depth + 1)));
            return pieces.every(p => p !== undefined) ? literal(pieces.join("")) : undefined;
        }
        if (language === "python") {
            const slash = split(s, "/");
            if (slash.length > 1) {
                const pieces = slash.map(p => evaluate(p, depth + 1));
                if (pieces[0]?.kind === "path" && pieces.every(p => string(p) !== undefined))
                    return { kind: "path", value: path.join(...pieces.map(p => string(p))) };
                return;
            }
        }
        if (s.endsWith(")")) {
            let nesting = 0, at = s.length - 1;
            for (; at >= 0; at--) {
                if (s[at] === ")")
                    nesting++;
                if (s[at] === "(" && --nesting === 0)
                    break;
            }
            if (at <= 0)
                return;
            const callable = evaluate(s.slice(0, at), depth + 1);
            if (callable?.kind !== "name") {
                unknownCall = true;
                return;
            }
            const expressions = split(s.slice(at + 1, -1), ","), args = expressions.map(p => evaluate(p.replace(/^\w+\s*=\s*/, ""), depth + 1));
            const n = callable.value, values = args.map(string);
            const named = new Map(expressions.flatMap((e, i) => { const m = e.trim().match(/^(\w+)\s*=/); return m ? [[m[1], args[i]]] : []; }));
            const positional = args.filter((_v, i) => !/^\s*\w+\s*=/.test(expressions[i]));
            if (n === "require" && ["fs", "node:fs", "fs/promises", "node:fs/promises", "path", "node:path", "os", "node:os"].includes(values[0] ?? ""))
                return name(values[0].replace(/^node:/, "").replace("fs/promises", "fs.promises"));
            if (n === "pathlib.Path.home")
                return home() ? { kind: "path", value: home() } : undefined;
            if (n === "pathlib.Path.cwd")
                return { kind: "path", value: cwd };
            if (n === "os.homedir")
                return literal(home());
            if (["os.getcwd", "process.cwd"].includes(n))
                return literal(cwd);
            if (["os.chdir", "process.chdir"].includes(n)) {
                if (values[0] !== undefined)
                    cwd = path.resolve(cwd, values[0]);
                else
                    unknownCall = true;
                return;
            }
            if (n === "str")
                return args[0];
            if (n === "pathlib.Path")
                return values[0] !== undefined ? { kind: "path", value: values[0] } : undefined;
            if (["path.join", "path.resolve", "os.path.join"].includes(n) && values.every(v => v !== undefined))
                return literal(n === "path.resolve" ? path.resolve(cwd, ...values) : path.join(...values));
            if (n === "os.path.expanduser" && values[0] !== undefined && home())
                return literal(values[0].replace(/^~(?=$|\/)/, home()));
            if (n === "open" || n === "io.open") {
                const mode = named.has("mode") ? string(named.get("mode")) : positional.length > 1 ? string(positional[1]) : "r";
                if (mode && /[wax+]/.test(mode))
                    add(named.has("file") ? named.get("file") : positional[0], "write");
                return;
            }
            if (n.startsWith("file:")) {
                const at = n.lastIndexOf(":"), filename = literal(n.slice(5, at)), method = n.slice(at + 1);
                if (["write_text", "write_bytes", "touch"].includes(method))
                    add(filename, "write");
                if (["unlink", "rmdir"].includes(method))
                    add(filename, "remove");
                if (["rename", "replace"].includes(method)) {
                    add(filename, "remove", true);
                    add(args[0], "replace", true);
                }
                if (method === "open" && /[wax+]/.test(values[0] ?? "r"))
                    add(filename, "write");
                if (method === "expanduser" && home())
                    return { kind: "path", value: string(filename).replace(/^~(?=$|\/)/, home()) };
                return;
            }
            if (/^fs\.(?:promises\.)?(?:writeFile|appendFile|createWriteStream|truncate|chmod|chown|mkdir)(?:Sync)?$/.test(n))
                add(args[0], "write");
            if (/^fs\.(?:promises\.)?open(?:Sync)?$/.test(n) && /[wax+]/.test(values[1] ?? ""))
                add(args[0], "write");
            if (/^fs\.(?:promises\.)?(?:unlink|rm|rmdir)(?:Sync)?$/.test(n) || /^(?:os\.(?:unlink|remove|rmdir)|shutil\.rmtree)$/.test(n))
                add(args[0], "remove", /rm|rmdir|rmtree/.test(n));
            if (/^fs\.(?:promises\.)?rename(?:Sync)?$/.test(n) || /^(?:os\.(?:rename|replace)|shutil\.move)$/.test(n)) {
                add(args[0], "remove", true);
                add(args[1], "replace", true);
            }
            if (/^fs\.(?:promises\.)?copyFile(?:Sync)?$/.test(n) || /^shutil\.copy(?:file|2)?$/.test(n))
                add(args[1], "write");
            if (!/^(?:fs\.(?:promises\.)?(?:writeFile|appendFile|createWriteStream|truncate|chmod|chown|mkdir|open|unlink|rm|rmdir|rename|copyFile|readFile|stat|lstat|access)(?:Sync)?|os\.(?:unlink|remove|rmdir|rename|replace)|shutil\.(?:move|copy|copyfile|copy2|rmtree)|print|console\.log)$/.test(n))
                unknownCall = true;
            return;
        }
        const dot = s.match(/^(.+)\.([A-Za-z_]\w*)$/);
        if (dot) {
            const base = evaluate(dot[1], depth + 1);
            if (base?.kind === "path")
                return name(`file:${base.value}:${dot[2]}`);
            if (base?.kind === "name") {
                if (base.value === "process.env")
                    return literal(environment.has(dot[2]) ? environment.get(dot[2]) : dot[2] === "HOME" ? home() : undefined);
                return name(base.value + "." + dot[2]);
            }
            return;
        }
        if (language === "node" && ["require", "process", "console"].includes(s) || language === "python" && ["open", "str", "print"].includes(s))
            return name(s);
        return;
    }
    for (const raw of split(masked, ";\n")) {
        const statement = raw.trim();
        if (!statement)
            continue;
        let match;
        if (language === "python" && (match = statement.match(/^import (.+)$/))) {
            for (const entry of match[1].split(",")) {
                const m = entry.trim().match(/^(os|pathlib|shutil|io)(?: as (\w+))?$/);
                if (!m)
                    return result;
                vars.set(m[2] ?? m[1], name(m[1]));
            }
            continue;
        }
        if (language === "python" && (match = statement.match(/^from (os|pathlib|shutil|io) import (\w+)(?: as (\w+))?$/))) {
            vars.set(match[3] ?? match[2], name(match[1] + "." + match[2]));
            continue;
        }
        if (language === "node" && (match = statement.match(/^import (?:\* as )?(\w+) from (@\d+@)$/))) {
            const module = string(evaluate(match[2]))?.replace(/^node:/, "").replace("fs/promises", "fs.promises");
            if (!module || !["fs", "fs.promises", "path", "os"].includes(module))
                break;
            vars.set(match[1], name(module));
            continue;
        }
        if (language === "python" && (match = statement.match(/^with (.+) as \w+:$/))) {
            evaluate(match[1]);
            break;
        }
        if ((match = statement.match(/^(?:(?:const|let|var)\s+)?(\w+)\s*=\s*(?!=)(.+)$/))) {
            const value = evaluate(match[2]);
            // An explicit unknown binding shadows a builtin as well.
            vars.set(match[1], value ?? name("unknown"));
            if (!value)
                break;
            continue;
        }
        if (!/^(?:await\s+)?[\w@.('"].*\)$/.test(statement))
            break;
        evaluate(statement);
        if (unknownCall)
            break;
        // Only known filesystem/read/print calls preserve tracked bindings/cwd.
        if (!/^(?:await\s+)?(?:[\w.]+|require\(@\d+@\)\.\w+|[\w.]+\([^;]*\)\.\w+)\(/.test(statement))
            break;
    }
    return result;
}
