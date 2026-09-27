import path from "node:path";
export const MAX_INPUT = 64 * 1024;
const unknown = { kind: "unknown" };
/** Small POSIX lexer. No evaluation, expansion, source, aliases or substitutions. */
export function shellWords(input) {
    if (Buffer.byteLength(input) > MAX_INPUT || /[\0\r]/.test(input))
        return;
    const words = [];
    let word = "", quote = "", started = false;
    const flush = () => { if (started)
        words.push({ value: word }); word = ""; started = false; };
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (quote === "'") {
            if (c === "'")
                quote = "";
            else
                word += c;
            continue;
        }
        if (c === "\\") {
            const next = input[++i];
            if (next === undefined)
                return;
            if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next))
                word += "\\";
            if (next !== "\n")
                word += next;
            started = true;
            continue;
        }
        if (c === "$" || c === "`")
            return;
        if (quote === '"') {
            if (c === '"')
                quote = "";
            else
                word += c;
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
        if (c === "\n") {
            flush();
            words.push({ value: ";", operator: true });
            continue;
        }
        if (/\s/.test(c)) {
            flush();
            continue;
        }
        if ("|&;<>".includes(c)) {
            flush();
            let op = c;
            if (input[i + 1] === c || (c === ">" && input[i + 1] === "&"))
                op += input[++i];
            words.push({ value: op, operator: true });
            continue;
        }
        if ("*?[]{}()~".includes(c))
            return;
        word += c;
        started = true;
        if (words.length > 512)
            return;
    }
    if (quote)
        return;
    flush();
    while (words.at(-1)?.value === ";" && words.at(-1)?.operator)
        words.pop();
    return words.length <= 512 ? words : undefined;
}
const valueFlags = new Set(["profile", "format", "f", "timeout", "group", "chat-id", "user", "open-dingtalk-id",
    "conversation-id", "message-id", "msg-id", "text", "content", "time", "direction", "limit", "as", "identity",
    "msg-type", "idempotency-key", "uuid", "keyword", "dimension", "ids", "kind", "events", "max-events", "duration", "query"]);
const boolFlags = new Set(["yes", "y", "ai-tag"]);
export function dwsArgv(argv) {
    if (!argv.length || argv.length > 512 || path.basename(argv[0]) !== "dws" || argv[0].length > 1024 || argv.some(x => typeof x !== "string"))
        return;
    const positional = [], opts = new Map();
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("-")) {
            positional.push(arg);
            continue;
        }
        const [flag, inline] = arg.replace(/^--?/, "").split(/=(.*)/s);
        const key = { f: "format", y: "yes", "chat-id": "group", identity: "as", uuid: "idempotency-key",
            "msg-id": "message-id", content: "text" }[flag] ?? flag;
        if (opts.has(key))
            return;
        if (boolFlags.has(flag)) {
            if (inline !== undefined && !["true", "false"].includes(inline))
                return;
            opts.set(key, inline ?? "true");
        }
        else if (valueFlags.has(flag)) {
            const value = inline ?? argv[++i];
            if (value === undefined || value.startsWith("--"))
                return;
            opts.set(key, value);
        }
        else
            return; // jq/mock/environment/client credentials and unknown switches cannot establish evidence.
    }
    const route = positional.join(" ");
    let kind;
    if (["chat message list", "chat +chat-messages", "chat +messages-list"].includes(route))
        kind = "read";
    else if (["chat message send", "chat +messages-send", "chat +messages-reply", "chat +send-to-group"].includes(route))
        kind = "send";
    else if (route === "event +listen-im")
        kind = "read";
    else if (route === "auth status")
        kind = "auth";
    else if (route === "aisearch person")
        kind = "people";
    else if (route === "contact user get-self")
        kind = "self";
    else
        return;
    if (route === "event +listen-im" && opts.has("events") && opts.get("events") !== "message")
        return;
    if (opts.has("format") && !["json", "ndjson"].includes(opts.get("format")))
        return;
    if (opts.has("as") && opts.get("as") !== "user")
        return;
    if (opts.has("msg-type") && opts.get("msg-type") !== "text")
        return;
    const targets = [opts.has("group") ? { kind: "conversation", id: opts.get("group") } : null,
        opts.has("conversation-id") ? { kind: "conversation", id: opts.get("conversation-id") } : null,
        opts.has("user") ? { kind: "user", id: opts.get("user") } : null,
        opts.has("open-dingtalk-id") ? { kind: "open", id: opts.get("open-dingtalk-id") } : null].filter(Boolean);
    if (targets.length > 1 || targets.some(t => !t.id || t.id.length > 256 || t.id.includes(",")))
        return;
    if (kind === "send" && (!targets.length || !opts.has("text")))
        return;
    if (route === "chat +send-to-group" && !targets[0]?.id.startsWith("cid"))
        return;
    const profile = opts.get("profile");
    if (profile && (profile.length > 512 || !/^[^\s,:]+:[^\s,:]+$/.test(profile)))
        return;
    if ((opts.get("message-id")?.length ?? 0) > 256)
        return;
    return { kind, executable: argv[0], profile, target: targets[0], body: opts.get("text"),
        messageId: opts.get("message-id"), listen: route === "event +listen-im" };
}
export function parseCommand(input, depth = 0) {
    if (depth > 3)
        return unknown;
    const words = shellWords(input);
    if (!words?.length)
        return unknown;
    if (words.at(-1)?.operator && words.at(-1)?.value === "&")
        words.pop();
    // Only discard exact write-only /dev/null redirects. Input redirects are unsupported.
    for (let i = 0; i < words.length; i++) {
        if (words[i].operator && words[i].value === ">" && words[i + 1]?.value === "/dev/null") {
            words.splice(i, 2);
            i--;
        }
        else if (words[i].value === "2" && words[i + 1]?.operator && words[i + 1].value === ">&" && words[i + 2]?.value === "1") {
            words.splice(i, 3);
            i--;
        }
    }
    if (words[0]?.value === "nohup")
        words.shift();
    if (words[0]?.value === "env") {
        words.shift();
        while (words[0] && /^(?:PYTHONUNBUFFERED|LANG|LC_ALL)=[^\s]*$/.test(words[0].value))
            words.shift();
        if (words.at(0)?.value === "--")
            words.shift();
    }
    const pipe = words.findIndex(w => w.operator && w.value === "|");
    if (pipe >= 0) {
        if (words.filter(w => w.operator).length !== 1)
            return unknown;
        const source = dwsArgv(words.slice(0, pipe).map(w => w.value));
        const candidate = fromWords(words.slice(pipe + 1), depth);
        if (source?.kind !== "read" || candidate.kind !== "script")
            return unknown;
        return { kind: "script", script: { ...candidate.script, stdin: source } };
    }
    return fromWords(words, depth);
}
function fromWords(words, depth) {
    if (words.some(w => w.operator))
        return unknown;
    const argv = words.map(w => w.value), executable = path.basename(argv[0] ?? "");
    if (["bash", "sh"].includes(executable)) {
        if (argv.length === 3 && ["-c", "-lc"].includes(argv[1])) {
            const inner = parseCommand(argv[2], depth + 1);
            return inner.kind === "other" ? { kind: "script", script: { language: "shell", code: argv[2] } } : inner;
        }
        if (argv.length === 2 && !argv[1].startsWith("-") && argv[1].endsWith(".sh"))
            return { kind: "script", script: { language: "shell", file: argv[1] } };
        return unknown;
    }
    if (/^python(?:\d+(?:\.\d+)?)?$/.test(executable)) {
        if (argv.length === 3 && argv[1] === "-c")
            return { kind: "script", script: { language: "python", code: argv[2] } };
        if (argv.length === 2 && argv[1].endsWith(".py") && !argv[1].startsWith("-"))
            return { kind: "script", script: { language: "python", file: argv[1] } };
        return unknown;
    }
    if (executable === "dws")
        return dwsArgv(argv) ?? unknown;
    return { kind: "other" };
}
