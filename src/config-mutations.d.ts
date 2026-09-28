export type Mutation = {
    path: string;
    kind: "write" | "replace" | "remove";
    tree?: boolean;
};
export declare const CONTROL_CONFIG_FILES: readonly ["mcp-servers.json5", "agents-list.json5"];
export declare function mutationMatches(mutation: Mutation, assets: readonly string[]): boolean;
/** Bounded, non-executing inspection. Unknown expressions do not become targets. */
export declare function shellMutations(command: string, baseDir: string, environment?: Map<string, string | undefined>, depth?: number): Mutation[];
export declare function resolveConfigMutations(tool: string, params: Record<string, unknown>, baseDir: string): Mutation[];
