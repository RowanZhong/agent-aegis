import type { ToolCallDefenseStrategy } from "./security-strategies.js";
/** Private adapter evidence. Never read this from model-supplied tool params. */
export type HermesSkillDeletion = {
    action: "delete" | "remove_file";
    name: string;
    skillDir: string;
    roots: string[];
    target: string;
    archiveDir?: string | null;
};
/** Wrap only the Hermes registration. The shared/OpenClaw strategy stays intact. */
export declare function withHermesSkillDeletion(strategy: ToolCallDefenseStrategy, home: string): ToolCallDefenseStrategy;
