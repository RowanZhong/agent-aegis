export type DeletionTarget = {
    value: string;
    baseDir: string;
    glob?: boolean;
    filtered?: boolean;
};
type Part = {
    text: string;
    expand: boolean;
    glob: boolean;
};
export type Word = {
    parts: Part[];
    op?: string;
    embedded?: string[];
};
type Inspection = {
    targets: DeletionTarget[];
    uncertain: boolean;
};
/** Bounded lexical inspection only: never expand a glob, run a substitution or source a file. */
export declare function shellWords(input: string, groups?: boolean): {
    words: Word[];
    embedded: string[];
} | undefined;
export declare function expand(word: Word, variables: Map<string, string | undefined>, cwd: string | undefined): {
    value?: string;
    glob: boolean;
};
/** A whole-name glob at the root clears a whole class of root entries. Narrow suffix globs remain usable. */
export declare function bulkDeletionRoot(value: string): string | undefined;
export declare function inspectDeletionCommand(command: string, baseDir: string, depth?: number): Inspection;
export {};
