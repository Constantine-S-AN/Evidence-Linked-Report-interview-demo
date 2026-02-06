"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendInterviewRecordingChunk,
  deleteInterviewRecording,
  finalizeInterviewRecording,
  initializeInterviewRecording,
  loadAllInterviewRecordings,
  type PersistedInterviewRecording,
} from "@/lib/interviewRecordingDb";
import { INTERVIEW_QUESTIONS } from "@/lib/interview";
import { getSupportedMimeType } from "@/lib/recording";

const MAX_RECORDING_DURATION_SEC = 120;
const MAX_RECORDING_DURATION_MS = MAX_RECORDING_DURATION_SEC * 1000;
const RECORDING_TIMESLICE_MS = 1000;
const STORAGE_WARNING_THRESHOLD_BYTES = 1_000_000;

interface InterviewRecordingView {
  questionId: number;
  mimeType: string;
  durationMs: number;
  createdAt: string;
  totalBytes: number;
  url: string;
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatCreatedAt(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  return date.toLocaleString();
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function toRecordingView(recording: PersistedInterviewRecording): InterviewRecordingView {
  return {
    questionId: recording.questionId,
    mimeType: recording.mimeType,
    durationMs: recording.durationMs,
    createdAt: recording.createdAt,
    totalBytes: recording.totalBytes,
    url: URL.createObjectURL(recording.blob),
  };
}

function revokeObjectUrls(urls: string[]): void {
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }
}

export default function InterviewPage() {
  const [activeQuestionId, setActiveQuestionId] = useState<number | null>(null);
  const [recordings, setRecordings] = useState<InterviewRecordingView[]>([]);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingQuestionIdRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordingMimeTypeRef = useRef<string>("audio/webm");
  const autoStopTimeoutRef = useRef<number | null>(null);
  const chunkPersistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const recordingUrlsRef = useRef<string[]>([]);

  const totalRecordingBytes = useMemo(() => {
    return recordings.reduce((sum, recording) => sum + recording.totalBytes, 0);
  }, [recordings]);
  const showStorageWarning = totalRecordingBytes >= STORAGE_WARNING_THRESHOLD_BYTES;

  const recordingByQuestionId = useMemo(() => {
    return new Map(recordings.map((recording) => [recording.questionId, recording] as const));
  }, [recordings]);

  const clearAutoStopTimeout = () => {
    if (autoStopTimeoutRef.current !== null) {
      window.clearTimeout(autoStopTimeoutRef.current);
      autoStopTimeoutRef.current = null;
    }
  };

  const replaceRecordings = useCallback((nextRecordings: InterviewRecordingView[]) => {
    const previousUrls = recordingUrlsRef.current;
    recordingUrlsRef.current = nextRecordings.map((recording) => recording.url);
    revokeObjectUrls(previousUrls);
    setRecordings(nextRecordings);
  }, []);

  const refreshRecordingsFromDb = useCallback(async () => {
    const questionIds = INTERVIEW_QUESTIONS.map((_, index) => index + 1);
    const persistedRecordings = await loadAllInterviewRecordings(questionIds);
    const nextRecordings = persistedRecordings.map((recording) => toRecordingView(recording));

    if (!mountedRef.current) {
      revokeObjectUrls(nextRecordings.map((recording) => recording.url));
      return;
    }

    replaceRecordings(nextRecordings);
  }, [replaceRecordings]);

  const releaseMediaResources = () => {
    clearAutoStopTimeout();

    const stream = mediaStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
    }

    mediaRecorderRef.current = null;
    mediaStreamRef.current = null;
    recordingQuestionIdRef.current = null;
    recordingStartedAtRef.current = null;
    recordingMimeTypeRef.current = "audio/webm";
    chunkPersistQueueRef.current = Promise.resolve();
  };

  const finalizeRecording = async () => {
    const questionId = recordingQuestionIdRef.current;
    const recordingStartedAt = recordingStartedAtRef.current;

    try {
      if (questionId === null || recordingStartedAt === null) {
        setErrorMessage("Recording metadata was lost. Please try again.");
        return;
      }

      await chunkPersistQueueRef.current;

      const durationMs = Math.max(Date.now() - recordingStartedAt, 0);
      await finalizeInterviewRecording(questionId, durationMs, recordingMimeTypeRef.current);
      await refreshRecordingsFromDb();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to save this recording. Please retry.",
      );
    } finally {
      releaseMediaResources();
      setActiveQuestionId(null);
      setIsFinalizing(false);
    }
  };

  const queueChunkPersist = (chunk: Blob) => {
    const questionId = recordingQuestionIdRef.current;
    const recordingStartedAt = recordingStartedAtRef.current;
    if (questionId === null || recordingStartedAt === null) {
      return;
    }

    const durationMsEstimate = Math.max(Date.now() - recordingStartedAt, 0);
    const fallbackMimeType = recordingMimeTypeRef.current;

    chunkPersistQueueRef.current = chunkPersistQueueRef.current
      .catch(() => {
        // Keep queue alive after a failed chunk write.
      })
      .then(async () => {
        await appendInterviewRecordingChunk({
          questionId,
          chunk,
          durationMsEstimate,
          fallbackMimeType,
        });
      })
      .catch((error) => {
        const message =
          error instanceof Error
            ? error.message
            : "Unable to persist recording chunk to IndexedDB.";
        setErrorMessage(message);
      });
  };

  const startRecording = async (questionId: number) => {
    if (activeQuestionId !== null || isFinalizing) {
      return;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErrorMessage("This browser does not support microphone recording.");
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      setErrorMessage("MediaRecorder is not available in this browser.");
      return;
    }

    setErrorMessage(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMimeType = getSupportedMimeType();
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);

      const recordingCreatedAt = new Date().toISOString();
      const recordingMimeType = recorder.mimeType || preferredMimeType || "audio/webm";

      await initializeInterviewRecording({
        questionId,
        createdAt: recordingCreatedAt,
        mimeType: recordingMimeType,
      });

      recordingQuestionIdRef.current = questionId;
      recordingStartedAtRef.current = Date.now();
      recordingMimeTypeRef.current = recordingMimeType;
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      chunkPersistQueueRef.current = Promise.resolve();

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          queueChunkPersist(event.data);
        }
      };
      recorder.onerror = () => {
        setErrorMessage("A recording error occurred. Please try again.");
      };
      recorder.onstop = () => {
        void finalizeRecording();
      };

      clearAutoStopTimeout();
      recorder.start(RECORDING_TIMESLICE_MS);
      setActiveQuestionId(questionId);

      autoStopTimeoutRef.current = window.setTimeout(() => {
        const activeRecorder = mediaRecorderRef.current;
        if (activeRecorder && activeRecorder.state === "recording") {
          setIsFinalizing(true);
          activeRecorder.stop();
        }
      }, MAX_RECORDING_DURATION_MS);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setErrorMessage("Microphone permission was denied. Please allow access and try again.");
      } else {
        setErrorMessage("Could not start recording. Please check your microphone.");
      }
      releaseMediaResources();
      setActiveQuestionId(null);
      setIsFinalizing(false);
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      return;
    }

    clearAutoStopTimeout();
    setIsFinalizing(true);
    recorder.stop();
  };

  const deleteRecordingForQuestion = async (questionId: number) => {
    if (activeQuestionId === questionId || isFinalizing) {
      return;
    }

    try {
      await deleteInterviewRecording(questionId);
      await refreshRecordingsFromDb();
      setErrorMessage(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to delete this recording.";
      setErrorMessage(message);
    }
  };

  const onRecordClick = async (questionId: number) => {
    if (activeQuestionId === questionId) {
      stopRecording();
      return;
    }

    await startRecording(questionId);
  };

  useEffect(() => {
    mountedRef.current = true;

    void refreshRecordingsFromDb().catch((error) => {
      const message =
        error instanceof Error ? error.message : "Unable to load recordings from IndexedDB.";
      if (mountedRef.current) {
        setErrorMessage(message);
      }
    });

    return () => {
      mountedRef.current = false;
      clearAutoStopTimeout();

      const recorder = mediaRecorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
      }

      const stream = mediaStreamRef.current;
      if (stream) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
      }

      revokeObjectUrls(recordingUrlsRef.current);
      recordingUrlsRef.current = [];
    };
  }, [refreshRecordingsFromDb]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-8 px-6 py-10">
      <section className="space-y-2">
        <h1 className="text-3xl font-semibold">Interview</h1>
        <p className="text-sm text-neutral-600">
          Demo UI for question prompts and voice recording controls.
        </p>
      </section>

      <section className="space-y-4">
        {INTERVIEW_QUESTIONS.map((question, index) => {
          const questionId = index + 1;
          const isRecording = activeQuestionId === questionId;
          const canInteract = activeQuestionId === null || isRecording;
          const recording = recordingByQuestionId.get(questionId);

          return (
            <article
              key={questionId}
              className="space-y-3 rounded-lg border border-neutral-200 p-4"
            >
              <p className="text-sm font-medium text-neutral-500">Question {questionId}</p>
              <p className="text-base">{question}</p>
              <button
                className={`rounded-md px-4 py-2 text-sm font-medium text-white ${
                  isRecording ? "bg-red-600 hover:bg-red-700" : "bg-neutral-800 hover:bg-neutral-900"
                }`}
                disabled={!canInteract || isFinalizing}
                onClick={() => {
                  void onRecordClick(questionId);
                }}
                type="button"
              >
                {isRecording ? (isFinalizing ? "Stopping..." : "Stop") : "Start recording"}
              </button>
              {isRecording ? (
                <p className="text-xs text-neutral-500">
                  Auto-stop enabled at {MAX_RECORDING_DURATION_SEC} seconds.
                </p>
              ) : null}

              {recording ? (
                <div className="space-y-2 rounded-md border border-neutral-200 p-3">
                  <audio className="w-full" controls preload="metadata" src={recording.url} />
                  <p className="text-xs text-neutral-600">
                    Recorded: {formatCreatedAt(recording.createdAt)} | Duration:{" "}
                    {formatDuration(recording.durationMs)} | {recording.mimeType}
                  </p>
                  <button
                    className="rounded-md border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isRecording || isFinalizing}
                    onClick={() => {
                      void deleteRecordingForQuestion(questionId);
                    }}
                    type="button"
                  >
                    Delete recording
                  </button>
                </div>
              ) : (
                <p className="text-sm text-neutral-500">No recording yet for this question.</p>
              )}
            </article>
          );
        })}
      </section>

      {errorMessage ? (
        <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage}
        </p>
      ) : null}

      {showStorageWarning ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          Saved audio currently uses about {formatMegabytes(totalRecordingBytes)}. This is above
          the ~1MB range where localStorage is often unreliable for audio, so recordings are stored
          in IndexedDB.
        </p>
      ) : null}

      <section className="flex items-center justify-between rounded-lg border border-neutral-200 p-4">
        <p className="text-sm text-neutral-600">
          Saved answers: {recordings.length} / {INTERVIEW_QUESTIONS.length}
        </p>
        <Link
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          href="/review"
        >
          Continue to Review
        </Link>
      </section>
    </main>
  );
}
