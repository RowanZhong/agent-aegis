import { type DwsCommand, type Target } from "./command.js";
export type Identity = {
    profile: string;
    userId: string;
    openId?: string;
    aliases: Map<string, string>;
};
export type SourceMessage = {
    messageId: string;
    conversationId: string;
    senderOpenId?: string;
    senderUserId?: string;
    fingerprint: string;
};
/** Only exact JSON and native tool envelopes; never scrape JSON from logs. */
export declare function resultObject(value: unknown): any | undefined;
export declare function verifiedIdentity(command: DwsCommand, value: unknown): Identity | undefined;
export declare function observePeople(identity: Identity, command: DwsCommand, value: unknown, reserve?: (bytes: number) => boolean): void;
export declare function externalMessages(command: DwsCommand, value: unknown, identity: Identity): SourceMessage[];
export declare function sameDestination(command: DwsCommand, source: SourceMessage, identity: Identity): boolean;
export declare function targetKey(target?: Target): string;
