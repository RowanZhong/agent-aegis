export declare const MAX_INPUT: number;
export type Target = {
    kind: "conversation" | "user" | "open";
    id: string;
};
export type DwsCommand = {
    kind: "read" | "send" | "auth" | "people" | "self";
    executable: string;
    profile?: string;
    target?: Target;
    body?: string;
    messageId?: string;
    listen?: boolean;
};
export type ScriptCandidate = {
    language: "python" | "shell";
    file?: string;
    code?: string;
    stdin?: DwsCommand;
};
export type Command = DwsCommand | {
    kind: "script";
    script: ScriptCandidate;
} | {
    kind: "other";
} | {
    kind: "unknown";
};
type Word = {
    value: string;
    operator?: boolean;
};
/** Small POSIX lexer. No evaluation, expansion, source, aliases or substitutions. */
export declare function shellWords(input: string): Word[] | undefined;
export declare function dwsArgv(argv: string[]): DwsCommand | undefined;
export declare function parseCommand(input: string, depth?: number): Command;
export {};
