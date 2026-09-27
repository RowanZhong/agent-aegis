import { type DwsCommand } from "./command.js";
export declare function digest(text: string): string;
export type OwnerDecision = "EXACT_OWNER_REQUEST" | "NO_EXACT_REQUEST" | "UNKNOWN";
/** Read the existing Aegis prompt snapshot transiently; retain only its digest.
 * Absence of the complete body disproves the exact-original-body exception.
 * If the body occurs in ambiguous prose, abstain rather than invent permission.
 */
export declare function ownerRequest(original: string | undefined, expectedDigest: string | undefined, trusted: boolean, send: DwsCommand): OwnerDecision;
