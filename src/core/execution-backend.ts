import type { BackgroundTaskChildProcess } from './registry.ts';

export const BG_EXECUTION_CHANNEL = 'sydney-kit:bg-execution:v1';
export const BG_EXECUTION_HOOK_CHANNEL = 'sydney-kit:bg-hook:v1';
export const BG_PERSISTENT_READY_CHANNEL = 'sydney-kit:bg-persistent-ready:v1';

export interface PersistentRemoteStart {
  id: string;
  cwd: string;
  name: string;
  command: string;
  description?: string | undefined;
  timeoutSeconds: number;
  maxOutputBytes: number;
  ownerSession?: string;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
}
export interface PersistentRemoteLogs {
  data: string;
  nextOffset: number;
  eof: boolean;
  size: number;
}
/** These methods operate on a captured remote route; no local command fallback. */
export interface PersistentRemoteExecution {
  start(request: PersistentRemoteStart): Promise<import('../persistent/client.ts').TaskRecord>;
  get(id: string, ownerSession?: string): Promise<import('../persistent/client.ts').TaskRecord>;
  list(cwd: string, ownerSession?: string): Promise<import('../persistent/client.ts').TaskList>;
  cancel(id: string, ownerSession?: string): Promise<import('../persistent/client.ts').TaskRecord>;
  logs(id: string, offset: number, maxBytes: number, ownerSession?: string): Promise<PersistentRemoteLogs>;
}


/** Discovery is synchronous. The provider closure must snapshot its route and cwd. */
export interface BackgroundExecutionProvider {
  readonly id?: string;
  readonly cwd?: string;
  readonly persistent?: PersistentRemoteExecution;
  spawn(command: string, isAgent: boolean): BackgroundTaskChildProcess;
}
export interface BackgroundExecutionRequest {
  provider?: BackgroundExecutionProvider;
  error?: unknown;
}
export type BackgroundExecutionResolver = () => BackgroundExecutionProvider | undefined;
export interface BackgroundExecutionDescriptor {
  kind: 'local' | 'external';
  id: string;
  /** Absent for legacy external providers: their closure owns the execution cwd. */
  cwd?: string;
}
