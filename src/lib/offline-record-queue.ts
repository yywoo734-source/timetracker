export type RecordWritePayload = {
  day: string;
  blocks: unknown;
  notes: unknown;
  categories: unknown;
};

type PendingWrite = {
  id: string;
  userId: string;
  day: string;
  payload: RecordWritePayload;
  updatedAt: number;
};

const DB_NAME = "timetracker-offline-db";
const DB_VERSION = 1;
const STORE = "record_writes";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("userId", "userId", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = await run(store);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return result;
  } finally {
    db.close();
  }
}

function reqToPromise<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function queueRecordWrite(userId: string, payload: RecordWritePayload) {
  const entry: PendingWrite = {
    id: `${userId}:${payload.day}`,
    userId,
    day: payload.day,
    payload,
    updatedAt: Date.now(),
  };

  await withStore("readwrite", async (store) => {
    await reqToPromise(store.put(entry));
  });
}

export async function removeQueuedRecordWrite(userId: string, day: string) {
  await withStore("readwrite", async (store) => {
    await reqToPromise(store.delete(`${userId}:${day}`));
  });
}

export async function getQueuedRecordWrites(userId: string) {
  return withStore("readonly", async (store) => {
    const index = store.index("userId");
    const rows = (await reqToPromise(index.getAll(userId))) as PendingWrite[];
    rows.sort((a, b) => a.updatedAt - b.updatedAt);
    return rows;
  });
}

export async function countQueuedRecordWrites(userId: string) {
  const rows = await getQueuedRecordWrites(userId);
  return rows.length;
}
