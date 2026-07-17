export function atomicWriteJson(path: string, value: unknown): Promise<void>;
export function withPersistenceLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
