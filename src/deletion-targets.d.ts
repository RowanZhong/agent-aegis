export type DeletionTarget = {
    value: string;
    baseDir: string;
    glob?: boolean;
    filtered?: boolean;
};
type Inspection = {
    targets: DeletionTarget[];
    uncertain: boolean;
};
/** A whole-name glob at the root clears a whole class of root entries. Narrow suffix globs remain usable. */
export declare function bulkDeletionRoot(value: string): string | undefined;
export declare function inspectDeletionCommand(command: string, baseDir: string, depth?: number): Inspection;
export {};
