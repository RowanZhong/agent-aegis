type Payload = Record<string, any>;
export declare function createHermesBridge(): {
    dispatch(method: string, payload: Payload): Promise<unknown>;
};
export {};
