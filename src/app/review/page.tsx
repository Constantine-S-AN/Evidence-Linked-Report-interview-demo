"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import CoverageMap from "@/components/CoverageMap";
import { buildCoverageModel } from "@/lib/coverage";
import type { CoverageInterval } from "@/lib/coverage";
import { INTERVIEW_QUESTIONS } from "@/lib/interview";
import {
  DEFAULT_RUBRIC_DIMENSIONS,
  isReportResponseBody,
  toModernReportResponse,
} from "@/lib/report";
import { loadReviewCache, saveReviewCache } from "@/lib/reviewCache";
import { loadInterviewRecordings } from "@/lib/storage";
import { recordingToFile } from "@/lib/transcribe";
import type { TranscribeResponse } from "@/lib/transcribe";
import type { InterviewRecording } from "@/types/interview";
import type {
  ModernReportResponseBody,
  ReportRequestBody,
  ReportResponseBody,
} from "@/types/report";

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

function formatSegmentTime(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainingSeconds.toFixed(1).padStart(4, "0")}`;
}

function formatUnitPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "0%";
  }
  const safeValue = Math.min(1, Math.max(0, value));
  return `${Math.round(safeValue * 100)}%`;
}

function isTranscribeResponse(value: unknown): value is TranscribeResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.transcriptText !== "string" || !Array.isArray(candidate.segments)) {
    return false;
  }

  return candidate.segments.every((segment) => {
    if (typeof segment !== "object" || segment === null) {
      return false;
    }
    const segmentRecord = segment as Record<string, unknown>;
    return (
      typeof segmentRecord.id === "string" &&
      typeof segmentRecord.start === "number" &&
      Number.isFinite(segmentRecord.start) &&
      typeof segmentRecord.end === "number" &&
      Number.isFinite(segmentRecord.end) &&
      typeof segmentRecord.text === "string"
    );
  });
}

function deleteQuestionKey<T>(
  previous: Partial<Record<number, T>>,
  questionId: number,
): Partial<Record<number, T>> {
  const next = { ...previous };
  delete next[questionId];
  return next;
}

function normalizeCachedReports(
  cachedReports: Partial<Record<number, ReportResponseBody>>,
  cachedTranscriptions: Partial<Record<number, TranscribeResponse>>,
): Partial<Record<number, ModernReportResponseBody>> {
  const normalized: Partial<Record<number, ModernReportResponseBody>> = {};

  for (const [questionIdString, report] of Object.entries(cachedReports)) {
    if (!report) {
      continue;
    }

    const questionId = Number(questionIdString);
    if (!Number.isInteger(questionId) || questionId <= 0) {
      continue;
    }

    const availableSegmentCount =
      cachedTranscriptions[questionId]?.segments.length ?? 1;
    const segments = cachedTranscriptions[questionId]?.segments;

    normalized[questionId] = toModernReportResponse(report, {
      dimensions: DEFAULT_RUBRIC_DIMENSIONS,
      availableSegmentCount,
      segments,
    });
  }

  return normalized;
}

export default function ReviewPage() {
  const [recordings, setRecordings] = useState<InterviewRecording[]>([]);
  const [transcriptions, setTranscriptions] = useState<Partial<Record<number, TranscribeResponse>>>(
    {},
  );
  const [transcribeLoadingByQuestionId, setTranscribeLoadingByQuestionId] = useState<
    Partial<Record<number, boolean>>
  >({});
  const [transcribeErrorByQuestionId, setTranscribeErrorByQuestionId] = useState<
    Partial<Record<number, string>>
  >({});
  const [reports, setReports] = useState<Partial<Record<number, ModernReportResponseBody>>>({});
  const [reportLoadingByQuestionId, setReportLoadingByQuestionId] = useState<
    Partial<Record<number, boolean>>
  >({});
  const [reportErrorByQuestionId, setReportErrorByQuestionId] = useState<
    Partial<Record<number, string>>
  >({});
  const [activeDimensionByQuestionId, setActiveDimensionByQuestionId] = useState<
    Partial<Record<number, string | null>>
  >({});

  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const highlightTimeoutBySegmentId = useRef<Record<string, number>>({});
  const hasLoadedReviewCacheRef = useRef(false);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setRecordings(loadInterviewRecordings());

      const reviewCache = loadReviewCache();
      const normalizedReports = normalizeCachedReports(
        reviewCache.reports,
        reviewCache.transcriptions,
      );

      setTranscriptions(reviewCache.transcriptions);
      setReports(normalizedReports);
      hasLoadedReviewCacheRef.current = true;
    }, 0);

    const highlightTimers = highlightTimeoutBySegmentId.current;

    return () => {
      window.clearTimeout(timeoutId);
      Object.values(highlightTimers).forEach((timerId) => {
        window.clearTimeout(timerId);
      });
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedReviewCacheRef.current) {
      return;
    }

    saveReviewCache({
      transcriptions,
      reports,
    });
  }, [transcriptions, reports]);

  const recordingByQuestionId = useMemo(() => {
    return new Map(recordings.map((recording) => [recording.questionId, recording] as const));
  }, [recordings]);

  const transcribeRecording = async (recording: InterviewRecording) => {
    const questionId = recording.questionId;

    setTranscribeLoadingByQuestionId((previous) => ({ ...previous, [questionId]: true }));
    setTranscribeErrorByQuestionId((previous) => ({ ...previous, [questionId]: "" }));
    setReportErrorByQuestionId((previous) => ({ ...previous, [questionId]: "" }));

    try {
      const file = recordingToFile(recording);
      const formData = new FormData();
      formData.append("audio", file);

      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      const payload: unknown = await response.json();
      if (!response.ok) {
        const errorRecord =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : null;
        const message =
          errorRecord && typeof errorRecord.error === "string"
            ? errorRecord.error
            : "Transcription failed.";
        throw new Error(message);
      }

      if (!isTranscribeResponse(payload)) {
        throw new Error("Unexpected transcription response format.");
      }

      const normalizedSegments = payload.segments.map((segment, index) => {
        const rawId =
          typeof segment.id === "string" && segment.id.length > 0
            ? segment.id
            : String(index + 1);
        const id = `q${questionId}-${rawId}`;
        const text = typeof segment.text === "string" ? segment.text : "";
        const start =
          typeof segment.start === "number" && Number.isFinite(segment.start)
            ? segment.start
            : 0;
        const end =
          typeof segment.end === "number" && Number.isFinite(segment.end) ? segment.end : start;
        return { id, start, end, text };
      });

      setTranscriptions((previous) => ({
        ...previous,
        [questionId]: {
          transcriptText: payload.transcriptText,
          segments: normalizedSegments,
        },
      }));
      setReports((previous) => deleteQuestionKey(previous, questionId));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "An unexpected transcription error occurred.";
      setTranscribeErrorByQuestionId((previous) => ({ ...previous, [questionId]: message }));
    } finally {
      setTranscribeLoadingByQuestionId((previous) => ({ ...previous, [questionId]: false }));
    }
  };

  const generateReport = async (
    questionId: number,
    questionText: string,
    transcription: TranscribeResponse,
  ) => {
    const requestBody: ReportRequestBody = {
      questionId: String(questionId),
      questionText,
      segments: transcription.segments,
      rubric: {
        dimensions: DEFAULT_RUBRIC_DIMENSIONS,
      },
    };

    setReportLoadingByQuestionId((previous) => ({ ...previous, [questionId]: true }));
    setReportErrorByQuestionId((previous) => ({ ...previous, [questionId]: "" }));

    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const payload: unknown = await response.json();
      if (!response.ok) {
        const errorRecord =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : null;
        const message =
          errorRecord && typeof errorRecord.error === "string"
            ? errorRecord.error
            : "Report generation failed.";
        throw new Error(message);
      }

      if (!isReportResponseBody(payload)) {
        throw new Error("Unexpected report response format.");
      }

      const normalizedReport = toModernReportResponse(payload, {
        dimensions: DEFAULT_RUBRIC_DIMENSIONS,
        availableSegmentCount: transcription.segments.length,
        segments: transcription.segments,
      });

      const segmentIds = new Set(transcription.segments.map((segment) => segment.id));
      const hasInvalidEvidence = normalizedReport.dimensions.some((dimension) => {
        if (dimension.evidence.length === 0) {
          return !dimension.notObserved;
        }
        return dimension.evidence.some((entry) => !segmentIds.has(entry.segmentId));
      });
      if (hasInvalidEvidence) {
        throw new Error("Report references missing transcript segments.");
      }

      setReports((previous) => ({
        ...previous,
        [questionId]: normalizedReport,
      }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "An unexpected report generation error occurred.";
      setReportErrorByQuestionId((previous) => ({ ...previous, [questionId]: message }));
    } finally {
      setReportLoadingByQuestionId((previous) => ({ ...previous, [questionId]: false }));
    }
  };

  const highlightSegmentForTwoSeconds = (segmentId: string) => {
    const segmentElement = document.getElementById(`seg-${segmentId}`);
    if (!segmentElement) {
      return;
    }

    segmentElement.scrollIntoView({ behavior: "smooth", block: "center" });

    const existingTimer = highlightTimeoutBySegmentId.current[segmentId];
    if (typeof existingTimer === "number") {
      window.clearTimeout(existingTimer);
    }

    segmentElement.classList.add("evidence-segment-highlight");
    highlightTimeoutBySegmentId.current[segmentId] = window.setTimeout(() => {
      segmentElement.classList.remove("evidence-segment-highlight");
      delete highlightTimeoutBySegmentId.current[segmentId];
    }, 2000);
  };

  const jumpAudioToSegment = async (questionId: number, startSeconds: number) => {
    const audioElement = audioRefs.current[String(questionId)];
    if (!audioElement) {
      return;
    }

    audioElement.currentTime =
      Number.isFinite(startSeconds) && startSeconds >= 0 ? startSeconds : 0;

    try {
      await audioElement.play();
    } catch {
      // Ignore playback interruption errors from the browser.
    }
  };

  const onEvidenceChipClick = async (questionId: number, segmentId: string) => {
    const transcription = transcriptions[questionId];
    if (!transcription) {
      return;
    }

    const segment = transcription.segments.find((entry) => entry.id === segmentId);
    if (!segment) {
      return;
    }

    highlightSegmentForTwoSeconds(segmentId);
    await jumpAudioToSegment(questionId, segment.start);
  };

  const onCoverageIntervalClick = async (
    questionId: number,
    interval: CoverageInterval,
    transcription: TranscribeResponse,
  ) => {
    await jumpAudioToSegment(questionId, interval.start);

    const overlappingSegments = transcription.segments.filter((segment) => {
      const overlaps = segment.start <= interval.end && segment.end >= interval.start;
      return overlaps;
    });

    const nearestSegment =
      overlappingSegments.length > 0
        ? overlappingSegments.reduce((nearest, candidate) => {
            const nearestDistance = Math.abs(nearest.start - interval.start);
            const candidateDistance = Math.abs(candidate.start - interval.start);
            return candidateDistance < nearestDistance ? candidate : nearest;
          })
        : transcription.segments.find((segment) => interval.segmentIds.includes(segment.id));

    if (nearestSegment) {
      highlightSegmentForTwoSeconds(nearestSegment.id);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <h1 className="text-3xl font-semibold">Review</h1>
      <p className="text-sm text-neutral-600">
        Loaded from browser storage. Transcripts and reports persist by question.
      </p>

      <section className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-600">
        Found {recordings.length} saved recording{recordings.length === 1 ? "" : "s"}.
      </section>

      <section className="space-y-4">
        {INTERVIEW_QUESTIONS.map((question, index) => {
          const questionId = index + 1;
          const recording = recordingByQuestionId.get(questionId);
          const transcription = transcriptions[questionId];
          const report = reports[questionId];
          const activeDimensionId = activeDimensionByQuestionId[questionId] ?? null;
          const isTranscribing = Boolean(transcribeLoadingByQuestionId[questionId]);
          const transcribeError = transcribeErrorByQuestionId[questionId];
          const isGeneratingReport = Boolean(reportLoadingByQuestionId[questionId]);
          const reportError = reportErrorByQuestionId[questionId];
          const coverageModel =
            transcription && report
              ? buildCoverageModel({
                  segments: transcription.segments,
                  report,
                  activeDimensionId,
                  durationSeconds:
                    recording && recording.durationMs > 0
                      ? recording.durationMs / 1000
                      : undefined,
                })
              : null;
          const activeDimensionLabel =
            report && activeDimensionId
              ? report.dimensions.find((dimension) => dimension.id === activeDimensionId)?.label ??
                activeDimensionId
              : null;
          const coverageByDimensionEntries = report?.coverageMap
            ? Object.entries(report.coverageMap.byDimension)
            : [];
          const coverageBySegmentEntries = report?.coverageMap
            ? Object.entries(report.coverageMap.bySegment)
            : [];
          const dimensionLabelById = report
            ? new Map(report.dimensions.map((dimension) => [dimension.id, dimension.label] as const))
            : new Map<string, string>();

          return (
            <article className="space-y-3 rounded-lg border border-neutral-200 p-4" key={questionId}>
              <p className="text-sm font-medium text-neutral-500">Question {questionId}</p>
              <p>{question}</p>

              {recording ? (
                <div className="space-y-2 rounded-md border border-neutral-200 p-3">
                  <audio
                    className="w-full"
                    controls
                    preload="metadata"
                    ref={(element) => {
                      audioRefs.current[String(questionId)] = element;
                    }}
                    src={recording.url}
                  />
                  <p className="text-xs text-neutral-600">
                    Recorded: {formatCreatedAt(recording.createdAt)} | Duration:{" "}
                    {formatDuration(recording.durationMs)} | {recording.mimeType}
                  </p>

                  {report && transcription && coverageModel ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-neutral-600">
                        <p>
                          Filter:{" "}
                          <span className="font-medium">
                            {activeDimensionLabel ?? "All evidence"}
                          </span>
                        </p>
                        {activeDimensionId ? (
                          <button
                            className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-100"
                            onClick={() => {
                              setActiveDimensionByQuestionId((previous) => ({
                                ...previous,
                                [questionId]: null,
                              }));
                            }}
                            type="button"
                          >
                            Clear filter
                          </button>
                        ) : null}
                      </div>

                      {coverageModel.citedSegmentCount > 0 ? (
                        <CoverageMap
                          model={coverageModel}
                          onIntervalClick={(interval) => {
                            void onCoverageIntervalClick(questionId, interval, transcription);
                          }}
                        />
                      ) : (
                        <p className="rounded border border-dashed border-neutral-300 p-2 text-xs text-neutral-500">
                          No evidence yet for the current filter.
                        </p>
                      )}
                    </div>
                  ) : null}

                  <button
                    className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isTranscribing}
                    onClick={() => {
                      void transcribeRecording(recording);
                    }}
                    type="button"
                  >
                    {isTranscribing ? "Transcribing..." : "Transcribe"}
                  </button>

                  <button
                    className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!transcription || isGeneratingReport}
                    onClick={() => {
                      if (!transcription) {
                        return;
                      }
                      void generateReport(questionId, question, transcription);
                    }}
                    type="button"
                  >
                    {isGeneratingReport ? "Generating..." : "Generate Report"}
                  </button>

                  {transcribeError ? (
                    <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700">
                      {transcribeError}
                    </p>
                  ) : null}

                  {transcription ? (
                    <div className="space-y-2 rounded-md border border-neutral-200 p-3">
                      <p className="text-sm font-medium">Transcript</p>
                      <p className="text-sm text-neutral-700">{transcription.transcriptText}</p>
                      <div className="space-y-2">
                        {transcription.segments.map((segment) => (
                          <div
                            className="rounded border border-neutral-200 px-3 py-2 text-sm"
                            data-start={segment.start}
                            id={`seg-${segment.id}`}
                            key={`${questionId}-${segment.id}`}
                          >
                            <p className="text-xs text-neutral-500">
                              {formatSegmentTime(segment.start)} - {formatSegmentTime(segment.end)}
                            </p>
                            <p>{segment.text}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {reportError ? (
                    <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700">
                      {reportError}
                    </p>
                  ) : null}

                  {report ? (
                    <section className="space-y-4 rounded-md border border-neutral-200 p-3">
                      <header className="space-y-2">
                        <h3 className="text-sm font-semibold">Evidence-Linked Report</h3>
                        <p className="text-sm text-neutral-700">{report.overallSummary}</p>
                        <p className="text-xs text-neutral-700">
                          Recommendation:{" "}
                          <span className="rounded bg-neutral-100 px-2 py-1 font-medium">
                            {report.overallRecommendation}
                          </span>
                        </p>
                        {report.leveling ? (
                          <p className="text-xs text-neutral-700">
                            Suggested leveling:{" "}
                            <span className="rounded bg-neutral-100 px-2 py-1 font-medium">
                              {report.leveling.role} ({report.leveling.level})
                            </span>
                          </p>
                        ) : null}
                      </header>

                      {report.calibrationNotes && report.calibrationNotes.length > 0 ? (
                        <section className="rounded border border-neutral-200 p-3">
                          <h4 className="text-xs font-semibold uppercase text-neutral-600">
                            Calibration Notes
                          </h4>
                          <ul className="mt-2 space-y-1 text-sm text-neutral-700">
                            {report.calibrationNotes.map((note, noteIndex) => (
                              <li key={`${questionId}-calibration-note-${noteIndex}`}>{note}</li>
                            ))}
                          </ul>
                        </section>
                      ) : null}

                      <div className="grid gap-3 md:grid-cols-2">
                        <section className="rounded border border-neutral-200 p-3">
                          <h4 className="text-xs font-semibold uppercase text-neutral-600">
                            Decision Rationale
                          </h4>
                          <ul className="mt-2 space-y-1 text-sm text-neutral-700">
                            {(report.decisionRationale ?? []).map((item, itemIndex) => (
                              <li key={`${questionId}-decision-${itemIndex}`}>{item}</li>
                            ))}
                          </ul>
                        </section>

                        <section className="rounded border border-neutral-200 p-3">
                          <h4 className="text-xs font-semibold uppercase text-neutral-600">
                            Key Strengths
                          </h4>
                          <ul className="mt-2 space-y-1 text-sm text-neutral-700">
                            {(report.keyStrengths ?? []).map((item, itemIndex) => (
                              <li key={`${questionId}-strength-${itemIndex}`}>{item}</li>
                            ))}
                          </ul>
                        </section>

                        <section className="rounded border border-neutral-200 p-3">
                          <h4 className="text-xs font-semibold uppercase text-neutral-600">
                            Key Risks
                          </h4>
                          <ul className="mt-2 space-y-1 text-sm text-neutral-700">
                            {(report.keyRisks ?? report.risks).map((item, itemIndex) => (
                              <li key={`${questionId}-key-risk-${itemIndex}`}>{item}</li>
                            ))}
                          </ul>
                        </section>

                        <section className="rounded border border-neutral-200 p-3">
                          <h4 className="text-xs font-semibold uppercase text-neutral-600">
                            Follow-Ups
                          </h4>
                          {report.followUps.length > 0 ? (
                            <ul className="mt-2 space-y-1 text-sm text-neutral-700">
                              {report.followUps.map((followUp, followUpIndex) => (
                                <li key={`${questionId}-followup-${followUpIndex}`}>{followUp}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-2 text-sm text-neutral-500">No follow-ups suggested.</p>
                          )}
                        </section>
                      </div>

                      {report.mustFixToHire && report.mustFixToHire.length > 0 ? (
                        <section className="rounded border border-amber-300 bg-amber-50 p-3">
                          <h4 className="text-xs font-semibold uppercase text-amber-800">
                            Must Fix To Hire
                          </h4>
                          <ul className="mt-2 space-y-1 text-sm text-amber-900">
                            {report.mustFixToHire.map((item, itemIndex) => (
                              <li key={`${questionId}-must-fix-${itemIndex}`}>{item}</li>
                            ))}
                          </ul>
                        </section>
                      ) : null}

                      {coverageByDimensionEntries.length > 0 || coverageBySegmentEntries.length > 0 ? (
                        <section className="space-y-3 rounded border border-neutral-200 p-3">
                          <h4 className="text-xs font-semibold uppercase text-neutral-600">
                            Coverage Map (Structured)
                          </h4>

                          <div className="grid gap-3 md:grid-cols-2">
                            <section className="space-y-2 rounded border border-neutral-200 p-3">
                              <p className="text-xs font-semibold uppercase text-neutral-600">
                                By Dimension
                              </p>
                              <div className="space-y-2 text-xs text-neutral-700">
                                {coverageByDimensionEntries.map(([dimensionId, entry]) => (
                                  <article
                                    className="space-y-1 rounded border border-neutral-200 p-2"
                                    key={`${questionId}-coverage-dimension-${dimensionId}`}
                                  >
                                    <p className="font-medium">
                                      {dimensionLabelById.get(dimensionId) ?? dimensionId}
                                    </p>
                                    <p>Coverage: {entry.coveragePct.toFixed(1)}%</p>
                                    <div className="flex flex-wrap gap-1">
                                      {entry.segmentIds.map((segmentId) => (
                                        <button
                                          className="rounded-full border border-neutral-300 px-2 py-1 hover:bg-neutral-100"
                                          key={`${questionId}-coverage-${dimensionId}-${segmentId}`}
                                          onClick={() => {
                                            void onEvidenceChipClick(questionId, segmentId);
                                          }}
                                          type="button"
                                        >
                                          {segmentId}
                                        </button>
                                      ))}
                                    </div>
                                  </article>
                                ))}
                              </div>
                            </section>

                            <section className="space-y-2 rounded border border-neutral-200 p-3">
                              <p className="text-xs font-semibold uppercase text-neutral-600">
                                By Segment
                              </p>
                              <div className="space-y-2 text-xs text-neutral-700">
                                {coverageBySegmentEntries.map(([segmentId, entry]) => (
                                  <article
                                    className="space-y-1 rounded border border-neutral-200 p-2"
                                    key={`${questionId}-coverage-segment-${segmentId}`}
                                  >
                                    <button
                                      className="rounded-full border border-neutral-300 px-2 py-1 hover:bg-neutral-100"
                                      onClick={() => {
                                        void onEvidenceChipClick(questionId, segmentId);
                                      }}
                                      type="button"
                                    >
                                      {segmentId}
                                    </button>
                                    <div className="flex flex-wrap gap-1">
                                      {entry.dimensions.map((dimensionId) => (
                                        <button
                                          className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-100"
                                          key={`${questionId}-coverage-segment-dimension-${segmentId}-${dimensionId}`}
                                          onClick={() => {
                                            setActiveDimensionByQuestionId((previous) => ({
                                              ...previous,
                                              [questionId]: dimensionId,
                                            }));
                                          }}
                                          type="button"
                                        >
                                          {dimensionLabelById.get(dimensionId) ?? dimensionId}
                                        </button>
                                      ))}
                                    </div>
                                  </article>
                                ))}
                              </div>
                            </section>
                          </div>
                        </section>
                      ) : null}

                      <div className="space-y-3">
                        {report.dimensions.map((dimension, dimensionIndex) => {
                          const scoreLabel =
                            dimension.notObserved || dimension.score === null
                              ? "Not Observed"
                              : `${dimension.score}/5`;

                          return (
                            <article
                              className="space-y-3 rounded border border-neutral-200 p-3 text-sm"
                              key={`${questionId}-dimension-${dimension.id}-${dimensionIndex}`}
                            >
                              <header className="space-y-1">
                                <button
                                  className={`font-medium ${
                                    activeDimensionId === dimension.id
                                      ? "underline decoration-2"
                                      : "hover:underline"
                                  }`}
                                  onClick={() => {
                                    setActiveDimensionByQuestionId((previous) => ({
                                      ...previous,
                                      [questionId]: dimension.id,
                                    }));
                                  }}
                                  type="button"
                                >
                                  {dimension.label} ({dimension.id})
                                </button>
                                <p className="text-xs text-neutral-600">
                                  Score: {scoreLabel} | Confidence: {dimension.confidence}% | Evidence:{" "}
                                  {dimension.evidenceCoverage.citedSegmentCount}/
                                  {dimension.evidenceCoverage.availableSegmentCount} segments cited |
                                  Evidence quality: {formatUnitPercent(dimension.evidenceQuality)} |
                                  Consistency: {formatUnitPercent(dimension.consistency)}
                                </p>
                              </header>

                              <section className="grid gap-3 md:grid-cols-2">
                                <div className="space-y-1 rounded border border-neutral-200 p-2">
                                  <p className="text-xs font-semibold uppercase text-neutral-600">
                                    Observed Signals
                                  </p>
                                  <ul className="space-y-1 text-xs text-neutral-700">
                                    {(dimension.observedSignals ?? dimension.observations ?? []).map(
                                      (signal, signalIndex) => (
                                        <li key={`${questionId}-${dimension.id}-signal-${signalIndex}`}>
                                          {signal}
                                        </li>
                                      ),
                                    )}
                                  </ul>
                                </div>
                                <div className="space-y-1 rounded border border-neutral-200 p-2">
                                  <p className="text-xs font-semibold uppercase text-neutral-600">
                                    Concerns
                                  </p>
                                  <ul className="space-y-1 text-xs text-neutral-700">
                                    {(dimension.concerns ?? dimension.missingSignals).map(
                                      (concern, concernIndex) => (
                                        <li key={`${questionId}-${dimension.id}-concern-${concernIndex}`}>
                                          {concern}
                                        </li>
                                      ),
                                    )}
                                  </ul>
                                  {(dimension.counterSignals ?? []).length > 0 ? (
                                    <>
                                      <p className="pt-1 text-xs font-semibold uppercase text-neutral-600">
                                        Counter Signals
                                      </p>
                                      <ul className="space-y-1 text-xs text-neutral-700">
                                        {(dimension.counterSignals ?? []).map(
                                          (counterSignal, counterSignalIndex) => (
                                            <li
                                              key={`${questionId}-${dimension.id}-counter-${counterSignalIndex}`}
                                            >
                                              {counterSignal}
                                            </li>
                                          ),
                                        )}
                                      </ul>
                                    </>
                                  ) : null}
                                </div>
                              </section>

                              <section className="space-y-1">
                                <p className="text-xs font-semibold uppercase text-neutral-600">
                                  Evidence
                                </p>
                                <div className="flex flex-wrap gap-2">
                                  {dimension.evidence.map((entry, entryIndex) => (
                                    <button
                                      className="rounded-full border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100"
                                      key={`${questionId}-${dimension.id}-${entry.segmentId}-${entryIndex}`}
                                      onClick={() => {
                                        void onEvidenceChipClick(questionId, entry.segmentId);
                                      }}
                                      type="button"
                                    >
                                      {entry.segmentId} ({entry.strength})
                                    </button>
                                  ))}
                                </div>

                                {dimension.evidence.length > 0 ? (
                                  <div className="space-y-2">
                                    {dimension.evidence.map((entry, entryIndex) => (
                                      <article
                                        className="rounded border border-neutral-200 p-2 text-xs text-neutral-700"
                                        key={`${questionId}-${dimension.id}-evidence-detail-${entry.segmentId}-${entryIndex}`}
                                      >
                                        <p className="font-medium">
                                          {entry.segmentId}: &quot;{entry.quote}&quot;
                                        </p>
                                        <p className="mt-1 text-neutral-600">{entry.interpretation}</p>
                                      </article>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-xs text-neutral-500">
                                    No cited evidence for this dimension.
                                  </p>
                                )}
                              </section>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-neutral-500">No saved recording for this question.</p>
              )}
            </article>
          );
        })}
      </section>

      <Link
        className="w-fit rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50"
        href="/interview"
      >
        Back to Interview
      </Link>

      <style>{`
        .evidence-segment-highlight {
          background-color: #fef3c7;
          border-color: #f59e0b;
          box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.35);
          transition: background-color 120ms ease;
        }
      `}</style>
    </main>
  );
}
