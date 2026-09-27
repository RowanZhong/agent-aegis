import { createHash } from "node:crypto";
import { MAX_INPUT, parseCommand } from "./command.js";
import { targetKey } from "./events.js";
export function digest(text) { return createHash("sha256").update(text).digest("hex"); }
/** Read the existing Aegis prompt snapshot transiently; retain only its digest.
 * Absence of the complete body disproves the exact-original-body exception.
 * If the body occurs in ambiguous prose, abstain rather than invent permission.
 */
export function ownerRequest(original, expectedDigest, trusted, send) {
    if (!trusted || !original || !expectedDigest || Buffer.byteLength(original) > MAX_INPUT || digest(original) !== expectedDigest || !send.body)
        return "UNKNOWN";
    for (const line of original.split("\n").slice(0, 128)) {
        const parsed = parseCommand(line.trim().replace(/^`(.*)`$/s, "$1"));
        if (parsed.kind === "send" && parsed.body === send.body && targetKey(parsed.target) === targetKey(send.target) && parsed.profile === send.profile)
            return "EXACT_OWNER_REQUEST";
    }
    if (original.includes(send.body))
        return "UNKNOWN";
    // Escape/encoding instructions can express literal originals without containing
    // the decoded bytes; unsupported encodings cannot establish a negative proof.
    if (/\\|&#?\w+;|base64|urlencode|decode|解码|转义/i.test(original))
        return "UNKNOWN";
    return "NO_EXACT_REQUEST";
}
