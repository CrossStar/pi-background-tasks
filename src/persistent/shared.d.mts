export function serviceRoot(): string;
export const root: string;
export function privateDir(directory: string): void;
export function endpoint(key: string, directory?: string): string;
export function rpc(address: string, method: string, params: unknown, directory?: string): Promise<unknown>;
