// @effect-diagnostics globalDate:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
/**
 * Where a cloud sandbox's session is kept between Mac server runs, so a
 * restarted server (or a Mac that slept through the relay giving up) attaches
 * to the same sandbox instead of starting a new one. The relay bearer is a
 * secret: the record holds only its name in the secret store.
 */

/** A remote process the runtime started; a restarted Mac lets it finish. */
export interface CloudProcessRecord {
  readonly id: string;
  readonly threadId: string;
  /** The claude session it runs (--resume / --session-id), when it is claude. */
  readonly claudeSessionId: string | null;
}

export interface CloudSessionRecord {
  /** The Mac worktree; one sandbox per worktree. */
  readonly worktreeKey: string;
  /** The thread whose turn started the sandbox. */
  readonly threadId: string;
  readonly sandboxName: string;
  readonly sandboxSessionId: string | null;
  /** The secret store name of the relay bearer. */
  readonly relayTokenRef: string;
  readonly remoteHome: string;
  readonly remoteCwd: string;
  /** The Mac's t3-code MCP endpoint the relay forwards to. */
  readonly mcpEndpoint: string;
  readonly processes: ReadonlyArray<CloudProcessRecord>;
  /**
   * The Mac worktree's state (HEAD and a tree of its files, ignored ones left
   * out) when it last matched the sandbox; a different state means the Mac
   * moved on without it.
   */
  readonly macState: string | null;
  /** When the sandbox was created, on the runtime's clock (epoch ms). */
  readonly createdAt: number;
}

export interface CloudSessionStore {
  readonly list: () => Promise<ReadonlyArray<CloudSessionRecord>>;
  readonly save: (record: CloudSessionRecord) => Promise<void>;
  readonly remove: (worktreeKey: string) => Promise<void>;
  readonly saveToken: (ref: string, token: string) => Promise<void>;
  readonly readToken: (ref: string) => Promise<string | null>;
  readonly removeToken: (ref: string) => Promise<void>;
}

/** A store that lives as long as the object: tests, and servers without a database. */
export const memoryCloudSessionStore = (): CloudSessionStore & {
  readonly records: Map<string, CloudSessionRecord>;
  readonly tokens: Map<string, string>;
} => {
  const records = new Map<string, CloudSessionRecord>();
  const tokens = new Map<string, string>();
  return {
    records,
    tokens,
    list: async () => [...records.values()],
    save: async (record) => void records.set(record.worktreeKey, record),
    remove: async (worktreeKey) => void records.delete(worktreeKey),
    saveToken: async (ref, token) => void tokens.set(ref, token),
    readToken: async (ref) => tokens.get(ref) ?? null,
    removeToken: async (ref) => void tokens.delete(ref),
  };
};
