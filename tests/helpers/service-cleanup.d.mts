export function cleanupServiceRoot(root: string): Promise<void>;
export function guardServiceRoot(t: {after(fn: () => Promise<void>): void}, root: string): void;
