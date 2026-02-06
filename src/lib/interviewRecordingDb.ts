const DB_NAME = "voice-interview-recordings-db";
const DB_VERSION = 1;
const METADATA_STORE = "recordingMetadata";
const CHUNK_STORE = "recordingChunks";
const CHUNK_BY_QUESTION_INDEX = "byQuestionId";

interface RecordingMetadataRow {
  questionId: number;
  createdAt: string;
  mimeType: string;
  totalBytes: number;
  durationMs: number;
  chunkCount: number;
  updatedAt: string;
}

interface RecordingChunkRow {
  key: string;
  questionId: number;
  index: number;
  blob: Blob;
}

export interface PersistedInterviewRecording {
  questionId: number;
  createdAt: string;
  mimeType: string;
  totalBytes: number;
  durationMs: number;
  blob: Blob;
}

interface InitializeRecordingInput {
  questionId: number;
  createdAt: string;
  mimeType: string;
}

interface AppendChunkInput {
  questionId: number;
  chunk: Blob;
  durationMsEstimate: number;
  fallbackMimeType: string;
}

function createChunkKey(questionId: number, chunkIndex: number): string {
  return `${questionId}:${chunkIndex}`;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed."));
    };
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    };
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this browser."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE, { keyPath: "questionId" });
      }

      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        const chunkStore = database.createObjectStore(CHUNK_STORE, { keyPath: "key" });
        chunkStore.createIndex(CHUNK_BY_QUESTION_INDEX, "questionId", { unique: false });
      } else {
        const chunkStore = request.transaction?.objectStore(CHUNK_STORE);
        if (chunkStore && !chunkStore.indexNames.contains(CHUNK_BY_QUESTION_INDEX)) {
          chunkStore.createIndex(CHUNK_BY_QUESTION_INDEX, "questionId", { unique: false });
        }
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Unable to open IndexedDB."));
    };
  });
}

function isMetadataRow(value: unknown): value is RecordingMetadataRow {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row.questionId === "number" &&
    Number.isInteger(row.questionId) &&
    row.questionId > 0 &&
    typeof row.createdAt === "string" &&
    row.createdAt.length > 0 &&
    typeof row.mimeType === "string" &&
    row.mimeType.length > 0 &&
    typeof row.totalBytes === "number" &&
    Number.isFinite(row.totalBytes) &&
    row.totalBytes >= 0 &&
    typeof row.durationMs === "number" &&
    Number.isFinite(row.durationMs) &&
    row.durationMs >= 0 &&
    typeof row.chunkCount === "number" &&
    Number.isInteger(row.chunkCount) &&
    row.chunkCount >= 0 &&
    typeof row.updatedAt === "string" &&
    row.updatedAt.length > 0
  );
}

function toSortedMetadataRows(items: unknown[]): RecordingMetadataRow[] {
  const rows = items.filter((item): item is RecordingMetadataRow => isMetadataRow(item));
  rows.sort((a, b) => a.questionId - b.questionId);
  return rows;
}

async function listChunkRowsByQuestionId(
  chunkStore: IDBObjectStore,
  questionId: number,
): Promise<RecordingChunkRow[]> {
  const rows: RecordingChunkRow[] = [];
  const index = chunkStore.index(CHUNK_BY_QUESTION_INDEX);
  const range = IDBKeyRange.only(questionId);

  await new Promise<void>((resolve, reject) => {
    const cursorRequest = index.openCursor(range);

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }

      const row = cursor.value;
      if (typeof row === "object" && row !== null) {
        const candidate = row as Record<string, unknown>;
        const key = candidate.key;
        const candidateQuestionId = candidate.questionId;
        const candidateIndex = candidate.index;
        const blob = candidate.blob;

        if (
          typeof key === "string" &&
          typeof candidateQuestionId === "number" &&
          Number.isInteger(candidateQuestionId) &&
          typeof candidateIndex === "number" &&
          Number.isInteger(candidateIndex) &&
          blob instanceof Blob
        ) {
          rows.push({
            key,
            questionId: candidateQuestionId,
            index: candidateIndex,
            blob,
          });
        }
      }

      cursor.continue();
    };

    cursorRequest.onerror = () => {
      reject(cursorRequest.error ?? new Error("Failed to read recording chunks."));
    };
  });

  rows.sort((a, b) => a.index - b.index);
  return rows;
}

async function deleteChunksByQuestionId(
  chunkStore: IDBObjectStore,
  questionId: number,
): Promise<void> {
  const keys: IDBValidKey[] = [];
  const index = chunkStore.index(CHUNK_BY_QUESTION_INDEX);
  const range = IDBKeyRange.only(questionId);

  await new Promise<void>((resolve, reject) => {
    const cursorRequest = index.openKeyCursor(range);

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }

      keys.push(cursor.primaryKey);
      cursor.continue();
    };

    cursorRequest.onerror = () => {
      reject(cursorRequest.error ?? new Error("Failed to enumerate recording chunk keys."));
    };
  });

  for (const key of keys) {
    chunkStore.delete(key);
  }
}

export async function initializeInterviewRecording(
  input: InitializeRecordingInput,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([METADATA_STORE, CHUNK_STORE], "readwrite");
    const transactionDonePromise = transactionDone(transaction);
    const metadataStore = transaction.objectStore(METADATA_STORE);
    const chunkStore = transaction.objectStore(CHUNK_STORE);

    await deleteChunksByQuestionId(chunkStore, input.questionId);
    metadataStore.put({
      questionId: input.questionId,
      createdAt: input.createdAt,
      mimeType: input.mimeType,
      totalBytes: 0,
      durationMs: 0,
      chunkCount: 0,
      updatedAt: input.createdAt,
    } satisfies RecordingMetadataRow);

    await transactionDonePromise;
  } finally {
    database.close();
  }
}

export async function appendInterviewRecordingChunk(input: AppendChunkInput): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([METADATA_STORE, CHUNK_STORE], "readwrite");
    const transactionDonePromise = transactionDone(transaction);
    const metadataStore = transaction.objectStore(METADATA_STORE);
    const chunkStore = transaction.objectStore(CHUNK_STORE);

    const existingMetadata = await requestToPromise<unknown>(metadataStore.get(input.questionId));
    const createdAt = new Date().toISOString();
    const metadata: RecordingMetadataRow = isMetadataRow(existingMetadata)
      ? existingMetadata
      : {
          questionId: input.questionId,
          createdAt,
          mimeType: input.fallbackMimeType,
          totalBytes: 0,
          durationMs: 0,
          chunkCount: 0,
          updatedAt: createdAt,
        };

    const chunkIndex = metadata.chunkCount;
    chunkStore.put({
      key: createChunkKey(input.questionId, chunkIndex),
      questionId: input.questionId,
      index: chunkIndex,
      blob: input.chunk,
    } satisfies RecordingChunkRow);

    metadata.chunkCount += 1;
    metadata.totalBytes += input.chunk.size;
    metadata.durationMs = Math.max(metadata.durationMs, Math.round(input.durationMsEstimate));
    metadata.mimeType =
      input.chunk.type.length > 0 ? input.chunk.type : metadata.mimeType || input.fallbackMimeType;
    metadata.updatedAt = new Date().toISOString();

    metadataStore.put(metadata);
    await transactionDonePromise;
  } finally {
    database.close();
  }
}

export async function finalizeInterviewRecording(
  questionId: number,
  durationMsEstimate: number,
  fallbackMimeType: string,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(METADATA_STORE, "readwrite");
    const transactionDonePromise = transactionDone(transaction);
    const metadataStore = transaction.objectStore(METADATA_STORE);
    const existingMetadata = await requestToPromise<unknown>(metadataStore.get(questionId));

    if (isMetadataRow(existingMetadata)) {
      const updated: RecordingMetadataRow = {
        ...existingMetadata,
        durationMs: Math.max(existingMetadata.durationMs, Math.round(durationMsEstimate)),
        mimeType: existingMetadata.mimeType || fallbackMimeType,
        updatedAt: new Date().toISOString(),
      };
      metadataStore.put(updated);
    }

    await transactionDonePromise;
  } finally {
    database.close();
  }
}

export async function deleteInterviewRecording(questionId: number): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([METADATA_STORE, CHUNK_STORE], "readwrite");
    const transactionDonePromise = transactionDone(transaction);
    const metadataStore = transaction.objectStore(METADATA_STORE);
    const chunkStore = transaction.objectStore(CHUNK_STORE);

    await deleteChunksByQuestionId(chunkStore, questionId);
    metadataStore.delete(questionId);
    await transactionDonePromise;
  } finally {
    database.close();
  }
}

async function loadInterviewRecordingByQuestionId(
  questionId: number,
): Promise<PersistedInterviewRecording | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([METADATA_STORE, CHUNK_STORE], "readonly");
    const transactionDonePromise = transactionDone(transaction);
    const metadataStore = transaction.objectStore(METADATA_STORE);
    const chunkStore = transaction.objectStore(CHUNK_STORE);

    const metadataUnknown = await requestToPromise<unknown>(metadataStore.get(questionId));
    if (!isMetadataRow(metadataUnknown)) {
      await transactionDonePromise;
      return null;
    }

    const chunkRows = await listChunkRowsByQuestionId(chunkStore, questionId);
    await transactionDonePromise;

    if (chunkRows.length === 0) {
      return null;
    }

    const blobs = chunkRows.map((row) => row.blob);
    const mimeType =
      metadataUnknown.mimeType ||
      blobs.find((blob) => blob.type.length > 0)?.type ||
      "audio/webm";
    const blob = new Blob(blobs, { type: mimeType });

    return {
      questionId: metadataUnknown.questionId,
      createdAt: metadataUnknown.createdAt,
      mimeType,
      totalBytes: metadataUnknown.totalBytes > 0 ? metadataUnknown.totalBytes : blob.size,
      durationMs: metadataUnknown.durationMs,
      blob,
    };
  } finally {
    database.close();
  }
}

export async function loadAllInterviewRecordings(
  questionIds?: number[],
): Promise<PersistedInterviewRecording[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(METADATA_STORE, "readonly");
    const transactionDonePromise = transactionDone(transaction);
    const metadataStore = transaction.objectStore(METADATA_STORE);
    const allMetadataUnknown = await requestToPromise<unknown[]>(metadataStore.getAll());
    await transactionDonePromise;

    const metadataRows = toSortedMetadataRows(allMetadataUnknown);
    const allowedQuestionIds = questionIds ? new Set(questionIds) : null;
    const filteredMetadata = allowedQuestionIds
      ? metadataRows.filter((row) => allowedQuestionIds.has(row.questionId))
      : metadataRows;

    const recordings = await Promise.all(
      filteredMetadata.map((row) => loadInterviewRecordingByQuestionId(row.questionId)),
    );

    return recordings
      .filter((recording): recording is PersistedInterviewRecording => recording !== null)
      .sort((a, b) => a.questionId - b.questionId);
  } finally {
    database.close();
  }
}
