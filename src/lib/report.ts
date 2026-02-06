import type {
  LegacyReportResponseBody,
  ModernReportResponseBody,
  OverallRecommendation,
  ReportAnchorAlignment,
  ReportAnchors,
  ReportCoverageMap,
  ReportDimension,
  ReportDimensionAssessment,
  ReportDimensionEvidence,
  ReportEvidenceCoverage,
  ReportInputSegment,
  ReportRequestBody,
  ReportResponseBody,
  ReportWhatWouldChangeScore,
} from "@/types/report";

const RECOMMENDATIONS = [
  "StrongHire",
  "Hire",
  "LeanHire",
  "LeanNo",
  "No",
] as const;

const COVERAGE_EPSILON_SECONDS = 0.05;

interface NormalizeOptions {
  dimensions: ReportDimension[];
  availableSegmentCount: number;
  segments?: ReportInputSegment[];
}

interface NormalizeContext {
  dimensions: ReportDimension[];
  availableSegmentCount: number;
  segments: ReportInputSegment[];
  segmentById: Map<string, ReportInputSegment>;
  segmentIds: string[];
  enforceSegmentValidation: boolean;
}

interface JsonSchemaObject {
  [key: string]: unknown;
}

type UnknownRecord = Record<string, unknown>;

export const DEFAULT_RUBRIC_DIMENSIONS: ReportDimension[] = [
  {
    key: "clarity",
    label: "Communication Clarity",
    description:
      "How clearly the candidate explains context, actions, and outcomes with concrete detail.",
  },
  {
    key: "problemSolving",
    label: "Problem Solving",
    description:
      "How effectively the candidate frames ambiguity, evaluates options, and justifies decisions.",
  },
  {
    key: "ownership",
    label: "Ownership",
    description:
      "How strongly the candidate demonstrates accountability, initiative, and measurable follow-through.",
  },
  {
    key: "collaboration",
    label: "Collaboration",
    description:
      "How well the candidate aligns stakeholders, handles disagreement, and drives execution with others.",
  },
] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function toNormalizedString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function toStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const unique = new Set<string>();
  for (const entry of value) {
    if (!isNonEmptyString(entry)) {
      continue;
    }
    unique.add(entry.trim());
  }

  return Array.from(unique);
}

function toOverallRecommendation(value: unknown): OverallRecommendation | null {
  if (typeof value !== "string") {
    return null;
  }
  if ((RECOMMENDATIONS as readonly string[]).includes(value)) {
    return value as OverallRecommendation;
  }
  return null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function toRelevance(value: unknown): number | null {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return null;
  }
  if (numeric > 1 && numeric <= 100) {
    return clamp(numeric / 100, 0, 1);
  }
  return clamp(numeric, 0, 1);
}

function createDefaultAnchors(label: string, description: string): ReportAnchors {
  const base = label.trim().length > 0 ? label.trim() : "the dimension";
  const detail = description.trim().length > 0 ? description.trim() : "the competency";

  return {
    "1": `Signals are largely absent for ${base}; examples stay vague and do not establish ${detail}.`,
    "2": `Some signals appear for ${base}, but evidence is inconsistent and outcomes are weakly supported.`,
    "3": `Adequate ${base} with at least one concrete example; reasoning is understandable but uneven in depth.`,
    "4": `Strong ${base} with clear reasoning, concrete tradeoffs, and credible outcomes tied to specific actions.`,
    "5": `Exceptional ${base}: consistently precise, high-impact examples with rigorous reasoning and measurable results.`,
  };
}

function normalizeAnchors(
  value: unknown,
  fallbackLabel: string,
  fallbackDescription: string,
): ReportAnchors {
  const defaults = createDefaultAnchors(fallbackLabel, fallbackDescription);
  if (!isRecord(value)) {
    return defaults;
  }

  return {
    "1": toNormalizedString(value["1"], defaults["1"]),
    "2": toNormalizedString(value["2"], defaults["2"]),
    "3": toNormalizedString(value["3"], defaults["3"]),
    "4": toNormalizedString(value["4"], defaults["4"]),
    "5": toNormalizedString(value["5"], defaults["5"]),
  };
}

function deriveRecommendation(scores: Array<number | null>): OverallRecommendation {
  const observedScores = scores.filter((score): score is number => typeof score === "number");
  if (observedScores.length === 0) {
    return "LeanNo";
  }

  const average =
    observedScores.reduce((sum, score) => sum + score, 0) / observedScores.length;

  if (average >= 4.5) {
    return "StrongHire";
  }
  if (average >= 3.8) {
    return "Hire";
  }
  if (average >= 3.2) {
    return "LeanHire";
  }
  if (average >= 2.5) {
    return "LeanNo";
  }
  return "No";
}

function ensureMinItems(
  entries: string[],
  fallbackEntries: string[],
  minItems: number,
  maxItems: number,
): string[] {
  const result = [...entries];
  for (const fallbackEntry of fallbackEntries) {
    if (result.length >= minItems) {
      break;
    }
    if (!result.includes(fallbackEntry)) {
      result.push(fallbackEntry);
    }
  }
  return result.slice(0, maxItems);
}

function normalizedContextFromRequest(requestBody: ReportRequestBody): NormalizeContext {
  const segments = requestBody.segments.map((segment) => {
    const start = clamp(toFiniteNumber(segment.start) ?? 0, 0, Number.MAX_SAFE_INTEGER);
    const endRaw = toFiniteNumber(segment.end) ?? start;
    const end = Math.max(start, clamp(endRaw, start, Number.MAX_SAFE_INTEGER));
    return {
      id: segment.id,
      start,
      end,
      text: segment.text,
    };
  });

  const segmentById = new Map(segments.map((segment) => [segment.id, segment] as const));

  return {
    dimensions: requestBody.rubric.dimensions,
    availableSegmentCount: segments.length,
    segments,
    segmentById,
    segmentIds: segments.map((segment) => segment.id),
    enforceSegmentValidation: true,
  };
}

function normalizeOptions(options: NormalizeOptions): NormalizeContext {
  const segments =
    options.segments?.map((segment) => ({
      id: segment.id,
      start: clamp(toFiniteNumber(segment.start) ?? 0, 0, Number.MAX_SAFE_INTEGER),
      end: Math.max(
        clamp(toFiniteNumber(segment.start) ?? 0, 0, Number.MAX_SAFE_INTEGER),
        clamp(
          toFiniteNumber(segment.end) ?? toFiniteNumber(segment.start) ?? 0,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      ),
      text: segment.text,
    })) ?? [];
  const segmentById = new Map(segments.map((segment) => [segment.id, segment] as const));

  return {
    dimensions: options.dimensions,
    availableSegmentCount: Math.max(1, options.availableSegmentCount),
    segments,
    segmentById,
    segmentIds: segments.map((segment) => segment.id),
    enforceSegmentValidation: segments.length > 0,
  };
}

function pickFallbackEvidenceSegments(
  context: NormalizeContext,
  dimensionIndex: number,
  desiredCount: number,
): ReportInputSegment[] {
  if (context.segments.length === 0 || desiredCount <= 0) {
    return [];
  }

  const picked: ReportInputSegment[] = [];
  const seen = new Set<string>();
  const targetCount = Math.min(desiredCount, context.segments.length);

  for (let offset = 0; offset < context.segments.length && picked.length < targetCount; offset += 1) {
    const segment = context.segments[(dimensionIndex + offset) % context.segments.length];
    if (seen.has(segment.id)) {
      continue;
    }
    seen.add(segment.id);
    picked.push(segment);
  }

  return picked;
}

function normalizeEvidence(
  rawValue: unknown,
  context: NormalizeContext,
  dimensionIndex: number,
  notObserved: boolean,
): ReportDimensionEvidence[] {
  const result: ReportDimensionEvidence[] = [];
  const seenSegmentIds = new Set<string>();

  if (Array.isArray(rawValue)) {
    for (const entry of rawValue) {
      if (!isRecord(entry)) {
        continue;
      }

      const rawSegmentId = toNormalizedString(entry.segmentId);
      if (rawSegmentId.length === 0 || seenSegmentIds.has(rawSegmentId)) {
        continue;
      }
      const knownSegment = context.segmentById.get(rawSegmentId);
      if (context.enforceSegmentValidation && !knownSegment) {
        continue;
      }

      const relevance =
        toRelevance(entry.relevance) ??
        toRelevance(entry.confidence) ??
        (notObserved ? 0.45 : 0.7);

      const fallbackQuote =
        knownSegment?.text.slice(0, 160) ?? "Evidence excerpt unavailable.";
      const quote = toNormalizedString(entry.quote, fallbackQuote);
      result.push({
        segmentId: rawSegmentId,
        quote,
        relevance,
      });
      seenSegmentIds.add(rawSegmentId);
    }
  }

  const desiredMinimum = notObserved ? 0 : Math.min(2, context.segments.length);
  if (result.length < desiredMinimum) {
    const fallbackSegments = pickFallbackEvidenceSegments(
      context,
      dimensionIndex,
      desiredMinimum - result.length,
    );
    for (const segment of fallbackSegments) {
      if (seenSegmentIds.has(segment.id)) {
        continue;
      }
      result.push({
        segmentId: segment.id,
        quote: segment.text.slice(0, 160),
        relevance: 0.64,
      });
      seenSegmentIds.add(segment.id);
    }
  }

  return result.slice(0, 4);
}

function normalizeAnchorAlignment(
  rawValue: unknown,
  score: number | null,
  missingSignals: string[],
): ReportAnchorAlignment {
  const fallbackChosenLevel = score ?? 3;
  const fallbackWhyMeets = score === null
    ? ["Insufficient observable signal to map to a reliable anchor level."]
    : ["Observed behaviors align with the selected rubric level."];
  const fallbackWhyNotHigher =
    missingSignals.length > 0
      ? missingSignals.slice(0, 2)
      : ["Additional concrete evidence would be required for a higher level."];

  if (!isRecord(rawValue)) {
    return {
      chosenLevel: fallbackChosenLevel,
      whyMeets: fallbackWhyMeets,
      whyNotHigher: fallbackWhyNotHigher,
    };
  }

  const chosenLevel = clamp(
    Math.round(toFiniteNumber(rawValue.chosenLevel) ?? fallbackChosenLevel),
    1,
    5,
  );
  const whyMeets = ensureMinItems(
    toStringArray(rawValue.whyMeets),
    fallbackWhyMeets,
    1,
    3,
  );
  const whyNotHigher = ensureMinItems(
    toStringArray(rawValue.whyNotHigher),
    fallbackWhyNotHigher,
    1,
    3,
  );

  return {
    chosenLevel,
    whyMeets,
    whyNotHigher,
  };
}

function normalizeWhatWouldChangeScore(
  rawValue: unknown,
  missingSignals: string[],
): ReportWhatWouldChangeScore {
  const fallbackUp = missingSignals.length > 0
    ? missingSignals.slice(0, 2)
    : ["Provide a concrete example with measurable outcome and explicit tradeoffs."];
  const fallbackDown = ["Vague statements without evidence would lower confidence in this score."];

  if (!isRecord(rawValue)) {
    return {
      up: ensureMinItems([], fallbackUp, 1, 3),
      down: ensureMinItems([], fallbackDown, 1, 3),
    };
  }

  return {
    up: ensureMinItems(toStringArray(rawValue.up), fallbackUp, 1, 3),
    down: ensureMinItems(toStringArray(rawValue.down), fallbackDown, 1, 3),
  };
}

function normalizeConfidence(
  rawConfidence: unknown,
  evidenceQuality: number,
  consistency: number,
  evidenceCoverageRatio: number,
): number {
  const explicitConfidence = toFiniteNumber(rawConfidence);
  if (explicitConfidence !== null) {
    return Math.round(clamp(explicitConfidence, 0, 100));
  }

  const inferred = (evidenceQuality * 0.45 + consistency * 0.35 + evidenceCoverageRatio * 0.2) * 100;
  return Math.round(clamp(inferred, 0, 100));
}

function normalizeDimension(
  rawDimension: unknown,
  descriptor: ReportDimension,
  dimensionIndex: number,
  context: NormalizeContext,
): ReportDimensionAssessment {
  const rawRecord = isRecord(rawDimension) ? rawDimension : {};
  const rawNotObserved = rawRecord.notObserved;
  const notObserved = typeof rawNotObserved === "boolean" ? rawNotObserved : false;

  const rawScore = toFiniteNumber(rawRecord.score);
  const score =
    notObserved || rawScore === null
      ? null
      : clamp(Math.round(rawScore), 1, 5);

  const anchors = normalizeAnchors(rawRecord.anchors, descriptor.label, descriptor.description);
  const missingSignalsFallback = notObserved
    ? [`Add direct evidence for ${descriptor.label} via concrete actions and outcomes.`]
    : [`Show stronger ${descriptor.label} evidence tied to measurable outcomes.`];
  const missingSignals = ensureMinItems(
    toStringArray(rawRecord.missingSignals),
    missingSignalsFallback,
    1,
    4,
  );

  const evidence = normalizeEvidence(rawRecord.evidence, context, dimensionIndex, notObserved);
  const citedSegmentCount = new Set(evidence.map((entry) => entry.segmentId)).size;
  const evidenceCoverage: ReportEvidenceCoverage = {
    citedSegmentCount,
    availableSegmentCount: context.availableSegmentCount,
  };
  const evidenceCoverageRatio =
    context.availableSegmentCount > 0
      ? citedSegmentCount / context.availableSegmentCount
      : 0;

  const evidenceQuality = clamp(
    toRelevance(rawRecord.evidenceQuality) ??
      (evidence.length > 0
        ? evidence.reduce((sum, entry) => sum + entry.relevance, 0) / evidence.length
        : notObserved
          ? 0.25
          : 0.5),
    0,
    1,
  );

  const consistency = clamp(
    toRelevance(rawRecord.consistency) ??
      (notObserved ? 0.35 : 0.62 + Math.min(evidenceCoverageRatio * 0.2, 0.18)),
    0,
    1,
  );

  const confidence = normalizeConfidence(
    rawRecord.confidence,
    evidenceQuality,
    consistency,
    evidenceCoverageRatio,
  );

  const observationsFallback =
    notObserved
      ? [
          `No concrete behavior in the transcript maps directly to ${descriptor.label}.`,
          "Further probing is required before assigning a reliable score.",
        ]
      : [
          `Observed signals suggest ${descriptor.label} at approximately level ${score ?? 3}.`,
          "Evidence contains specific statements but could include more quantification.",
        ];
  const observations = ensureMinItems(
    toStringArray(rawRecord.observations),
    observationsFallback,
    2,
    4,
  );

  const anchorAlignment = normalizeAnchorAlignment(
    rawRecord.anchorAlignment,
    score,
    missingSignals,
  );

  const probesFallback = notObserved
    ? [
        `Describe a situation that demonstrates ${descriptor.label} with concrete steps.`,
        "What outcome changed because of your direct actions?",
      ]
    : [
        "Which tradeoff did you reject and why?",
        "What metric changed after your intervention?",
      ];
  const probes = ensureMinItems(toStringArray(rawRecord.probes), probesFallback, 2, 3);

  const whatWouldChangeScore = normalizeWhatWouldChangeScore(
    rawRecord.whatWouldChangeScore,
    missingSignals,
  );

  return {
    id: descriptor.key,
    label: descriptor.label,
    score,
    notObserved,
    confidence,
    anchors,
    missingSignals,
    evidence,
    evidenceCoverage,
    observations,
    anchorAlignment,
    evidenceQuality,
    consistency,
    probes,
    whatWouldChangeScore,
  };
}

function mergeIntervals(
  intervals: Array<{ start: number; end: number }>,
  epsilonSeconds: number,
): Array<{ start: number; end: number }> {
  if (intervals.length === 0) {
    return [];
  }

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...interval });
      continue;
    }
    if (interval.start <= last.end + epsilonSeconds) {
      last.end = Math.max(last.end, interval.end);
      continue;
    }
    merged.push({ ...interval });
  }

  return merged;
}

function deriveDurationSeconds(segments: ReportInputSegment[]): number {
  const maxEnd = segments.reduce((maxValue, segment) => Math.max(maxValue, segment.end), 0);
  return maxEnd > 0 ? maxEnd : 1;
}

function createCoverageMap(
  dimensions: ReportDimensionAssessment[],
  segments: ReportInputSegment[],
): ReportCoverageMap {
  const segmentById = new Map(segments.map((segment) => [segment.id, segment] as const));
  const durationSeconds = deriveDurationSeconds(segments);
  const byDimension: ReportCoverageMap["byDimension"] = {};
  const bySegment: ReportCoverageMap["bySegment"] = {};

  for (const dimension of dimensions) {
    const segmentIds = Array.from(
      new Set(
        dimension.evidence
          .map((entry) => entry.segmentId)
          .filter((segmentId) => segmentById.has(segmentId)),
      ),
    );

    const intervals = segmentIds
      .map((segmentId) => segmentById.get(segmentId))
      .filter((segment): segment is ReportInputSegment => segment !== undefined)
      .map((segment) => ({
        start: clamp(segment.start, 0, durationSeconds),
        end: clamp(Math.max(segment.end, segment.start), 0, durationSeconds),
      }));

    const mergedIntervals = mergeIntervals(intervals, COVERAGE_EPSILON_SECONDS);
    const coveredSeconds = mergedIntervals.reduce((sum, interval) => {
      return sum + Math.max(interval.end - interval.start, 0);
    }, 0);
    const coveragePct = clamp((coveredSeconds / durationSeconds) * 100, 0, 100);

    byDimension[dimension.id] = {
      segmentIds,
      coveragePct: Math.round(coveragePct * 10) / 10,
    };

    for (const segmentId of segmentIds) {
      const existing = bySegment[segmentId];
      if (existing) {
        if (!existing.dimensions.includes(dimension.id)) {
          existing.dimensions.push(dimension.id);
        }
      } else {
        bySegment[segmentId] = { dimensions: [dimension.id] };
      }
    }
  }

  return {
    byDimension,
    bySegment,
  };
}

function createCoverageMapFromEvidence(
  dimensions: ReportDimensionAssessment[],
  availableSegmentCount: number,
): ReportCoverageMap {
  const safeAvailableCount = Math.max(1, availableSegmentCount);
  const byDimension: ReportCoverageMap["byDimension"] = {};
  const bySegment: ReportCoverageMap["bySegment"] = {};

  for (const dimension of dimensions) {
    const segmentIds = Array.from(new Set(dimension.evidence.map((entry) => entry.segmentId)));
    const coveragePct = clamp((segmentIds.length / safeAvailableCount) * 100, 0, 100);
    byDimension[dimension.id] = {
      segmentIds,
      coveragePct: Math.round(coveragePct * 10) / 10,
    };

    for (const segmentId of segmentIds) {
      const existing = bySegment[segmentId];
      if (existing) {
        if (!existing.dimensions.includes(dimension.id)) {
          existing.dimensions.push(dimension.id);
        }
      } else {
        bySegment[segmentId] = { dimensions: [dimension.id] };
      }
    }
  }

  return {
    byDimension,
    bySegment,
  };
}

function buildTopLevelArrays(
  report: Partial<ModernReportResponseBody>,
  dimensions: ReportDimensionAssessment[],
  recommendation: OverallRecommendation,
): {
  decisionRationale: string[];
  keyStrengths: string[];
  keyRisks: string[];
  mustFixToHire: string[];
  risks: string[];
  followUps: string[];
} {
  const highDimensions = dimensions
    .filter((dimension) => !dimension.notObserved && typeof dimension.score === "number" && dimension.score >= 4)
    .slice(0, 3);
  const lowDimensions = dimensions
    .filter((dimension) => dimension.notObserved || (typeof dimension.score === "number" && dimension.score <= 2))
    .slice(0, 3);

  const fallbackDecisionRationale = [
    `Recommendation is ${recommendation} based on observed rubric evidence.`,
    "Scores emphasize anchor alignment, evidence quality, and cross-segment consistency.",
    "Confidence reflects both breadth of evidence and specificity of cited statements.",
  ];

  const fallbackStrengths = highDimensions.length > 0
    ? highDimensions.map((dimension) => `${dimension.label}: aligned with higher rubric anchors.`)
    : ["No clear high-signal strengths were consistently observed."];

  const fallbackRisks = lowDimensions.length > 0
    ? lowDimensions.map((dimension) =>
        dimension.notObserved
          ? `${dimension.label}: not observed; targeted probing required.`
          : `${dimension.label}: current evidence does not yet support stronger anchor levels.`,
      )
    : ["No critical hiring risks were identified from this response alone."];

  const fallbackFollowUps = dimensions
    .flatMap((dimension) => dimension.probes ?? [])
    .slice(0, 4);

  const decisionRationale = ensureMinItems(
    toStringArray(report.decisionRationale),
    fallbackDecisionRationale,
    3,
    5,
  );
  const keyStrengths = ensureMinItems(toStringArray(report.keyStrengths), fallbackStrengths, 1, 5);
  const keyRisks = ensureMinItems(toStringArray(report.keyRisks), fallbackRisks, 1, 4);
  const followUps = ensureMinItems(toStringArray(report.followUps), fallbackFollowUps, 1, 6);
  const risks = ensureMinItems(toStringArray(report.risks), keyRisks, 1, 6);

  const fallbackMustFix =
    recommendation === "StrongHire" || recommendation === "Hire"
      ? []
      : [
          "Provide at least one concrete example with measurable outcome for the weakest dimension.",
          "Clarify decision tradeoffs and ownership boundaries in follow-up questions.",
        ];
  const mustFixToHire = ensureMinItems(
    toStringArray(report.mustFixToHire),
    fallbackMustFix,
    fallbackMustFix.length > 0 ? 1 : 0,
    4,
  );

  return {
    decisionRationale,
    keyStrengths,
    keyRisks,
    mustFixToHire,
    risks,
    followUps,
  };
}

function normalizeModernReport(
  sourceReport: Partial<ModernReportResponseBody>,
  context: NormalizeContext,
): ModernReportResponseBody {
  const sourceDimensions = Array.isArray(sourceReport.dimensions)
    ? sourceReport.dimensions
    : [];
  const sourceById = new Map<string, unknown>();
  for (const candidate of sourceDimensions) {
    if (!isRecord(candidate)) {
      continue;
    }
    const id = toNormalizedString(candidate.id);
    if (id.length > 0 && !sourceById.has(id)) {
      sourceById.set(id, candidate);
    }
  }

  const normalizedDimensions = context.dimensions.map((descriptor, index) => {
    const candidate = sourceById.get(descriptor.key);
    return normalizeDimension(candidate, descriptor, index, context);
  });

  const recommendation =
    toOverallRecommendation(sourceReport.overallRecommendation) ??
    deriveRecommendation(normalizedDimensions.map((dimension) => dimension.score));

  const topLevel = buildTopLevelArrays(sourceReport, normalizedDimensions, recommendation);
  const summary = toNormalizedString(
    sourceReport.overallSummary,
    "Interview response reviewed with anchor-based scoring and evidence-linked notes.",
  );

  const coverageMap =
    context.segments.length > 0
      ? createCoverageMap(normalizedDimensions, context.segments)
      : createCoverageMapFromEvidence(normalizedDimensions, context.availableSegmentCount);

  return {
    overallSummary: summary,
    overallRecommendation: recommendation,
    risks: topLevel.risks,
    followUps: topLevel.followUps,
    dimensions: normalizedDimensions,
    decisionRationale: topLevel.decisionRationale,
    keyStrengths: topLevel.keyStrengths,
    keyRisks: topLevel.keyRisks,
    mustFixToHire: topLevel.mustFixToHire,
    coverageMap,
  };
}

function fromLegacyReport(
  report: LegacyReportResponseBody,
  options: NormalizeOptions,
): ModernReportResponseBody {
  const context = normalizeOptions(options);
  const legacyItems = Array.isArray(report.items) ? report.items : [];
  const itemByKey = new Map(legacyItems.map((item) => [item.dimensionKey, item] as const));

  const modernLike: Partial<ModernReportResponseBody> = {
    overallSummary: report.summary,
    dimensions: context.dimensions.map((descriptor) => {
      const legacyItem = itemByKey.get(descriptor.key);
      const evidenceEntries = legacyItem?.evidence?.map((entry) => ({
        segmentId: entry.segmentId,
        quote: entry.quote,
        relevance: toRelevance(entry.confidence) ?? 0.65,
      }));

      const score = legacyItem ? clamp(Math.round(legacyItem.score), 1, 5) : null;

      return {
        id: descriptor.key,
        label: descriptor.label,
        score,
        notObserved: legacyItem ? false : true,
        confidence: legacyItem ? 66 : 38,
        anchors: createDefaultAnchors(descriptor.label, descriptor.description),
        missingSignals: legacyItem
          ? ["Add stronger quantified impact and clearer tradeoff framing."]
          : [`No direct signal observed for ${descriptor.label}.`],
        evidence: evidenceEntries ?? [],
        evidenceCoverage: {
          citedSegmentCount: evidenceEntries?.length ?? 0,
          availableSegmentCount: context.availableSegmentCount,
        },
        observations: legacyItem
          ? [legacyItem.claim, "Legacy report migrated into anchor-based rubric format."]
          : ["Legacy report had no matching item for this dimension.", "Further probing required."],
        anchorAlignment: {
          chosenLevel: score ?? 3,
          whyMeets: legacyItem ? [legacyItem.claim] : ["Not enough evidence to assign a level."],
          whyNotHigher: ["Need more specific evidence and measurable impact statements."],
        },
        evidenceQuality: legacyItem ? 0.64 : 0.3,
        consistency: legacyItem ? 0.6 : 0.35,
        probes: [
          "What specific metric changed because of your approach?",
          "Which stakeholder tradeoff did you explicitly manage?",
        ],
        whatWouldChangeScore: {
          up: ["Add a quantified outcome and a clear decision rationale."],
          down: ["Remove concrete examples or rely on unsupported claims."],
        },
      } satisfies Partial<ReportDimensionAssessment>;
    }),
  };

  return normalizeModernReport(modernLike, context);
}

function getDimensionScoreForMock(index: number): number {
  const cycle = [4, 3, 5, 2];
  return cycle[index % cycle.length];
}

function createMockDimension(
  descriptor: ReportDimension,
  dimensionIndex: number,
  context: NormalizeContext,
  forceNotObserved: boolean,
): ReportDimensionAssessment {
  const anchors = createDefaultAnchors(descriptor.label, descriptor.description);
  if (forceNotObserved) {
    return {
      id: descriptor.key,
      label: descriptor.label,
      score: null,
      notObserved: true,
      confidence: 34,
      anchors,
      missingSignals: [
        `No transcript segment clearly demonstrates ${descriptor.label}.`,
        "Need a concrete example with role, action, and measurable result.",
      ],
      evidence: [],
      evidenceCoverage: {
        citedSegmentCount: 0,
        availableSegmentCount: context.availableSegmentCount,
      },
      observations: [
        `Current answer does not provide direct behavioral evidence for ${descriptor.label}.`,
        "Interviewer should probe for a specific situation and outcome.",
      ],
      anchorAlignment: {
        chosenLevel: 2,
        whyMeets: ["Only partial or indirect signals were present in the response."],
        whyNotHigher: ["No concrete segment linked to this dimension was observed."],
      },
      evidenceQuality: 0.22,
      consistency: 0.31,
      probes: [
        `Can you share one example that directly demonstrates ${descriptor.label}?`,
        "What did you personally do, and what changed as a result?",
      ],
      whatWouldChangeScore: {
        up: ["Provide a specific scenario with measurable impact and clear ownership."],
        down: ["Continue with abstract statements without role-specific actions."],
      },
    };
  }

  const fallbackSegments = pickFallbackEvidenceSegments(context, dimensionIndex, 2);
  const evidence = fallbackSegments.map((segment, evidenceIndex) => ({
    segmentId: segment.id,
    quote: segment.text.slice(0, 160),
    relevance: clamp(0.7 - evidenceIndex * 0.08 + dimensionIndex * 0.03, 0.45, 0.92),
  }));

  const score = getDimensionScoreForMock(dimensionIndex);
  const citedSegmentCount = new Set(evidence.map((entry) => entry.segmentId)).size;
  const coverageRatio =
    context.availableSegmentCount > 0
      ? citedSegmentCount / context.availableSegmentCount
      : 0;
  const evidenceQuality = clamp(
    evidence.reduce((sum, entry) => sum + entry.relevance, 0) / Math.max(1, evidence.length),
    0,
    1,
  );
  const consistency = clamp(0.56 + (score - 2) * 0.08, 0, 1);
  const confidence = Math.round(
    clamp((evidenceQuality * 0.45 + consistency * 0.35 + coverageRatio * 0.2) * 100, 0, 100),
  );

  return {
    id: descriptor.key,
    label: descriptor.label,
    score,
    notObserved: false,
    confidence,
    anchors,
    missingSignals: [
      "Add one more quantified outcome to increase anchor certainty.",
      "Clarify rejected alternatives and why they were deprioritized.",
    ],
    evidence,
    evidenceCoverage: {
      citedSegmentCount,
      availableSegmentCount: context.availableSegmentCount,
    },
    observations: [
      `${descriptor.label} is demonstrated with specific actions in cited transcript segments.`,
      "Reasoning is mostly coherent but could better quantify downstream impact.",
      "Decision framing is credible and tied to candidate-owned execution.",
    ],
    anchorAlignment: {
      chosenLevel: score,
      whyMeets: [
        "Cited evidence aligns with the selected anchor level through concrete behaviors.",
        "Transcript includes explicit context, action, and outcome links.",
      ],
      whyNotHigher: [
        "Evidence breadth is limited; additional scenarios would increase confidence.",
        "Some claims would be stronger with objective metrics.",
      ],
    },
    evidenceQuality,
    consistency,
    probes: [
      "What was the hardest tradeoff you made, and how did you validate it?",
      "Which metric or signal best proved your approach worked?",
      "If you repeated this now, what would you change first?",
    ],
    whatWouldChangeScore: {
      up: [
        "Show a second independent example with equal rigor and measurable impact.",
        "Quantify stakeholder outcomes and include explicit risk mitigation choices.",
      ],
      down: [
        "Rely on generic claims that are not tied to transcript evidence.",
        "Contradict key details across examples without reconciliation.",
      ],
    },
  };
}

function createMockTopLevel(
  questionText: string,
  dimensions: ReportDimensionAssessment[],
): Pick<
  ModernReportResponseBody,
  | "overallSummary"
  | "overallRecommendation"
  | "risks"
  | "followUps"
  | "decisionRationale"
  | "keyStrengths"
  | "keyRisks"
  | "mustFixToHire"
> {
  const recommendation = deriveRecommendation(dimensions.map((dimension) => dimension.score));
  const strengths = dimensions
    .filter((dimension) => !dimension.notObserved && (dimension.score ?? 0) >= 4)
    .map((dimension) => `${dimension.label}: evidence supports higher-anchor behavior.`)
    .slice(0, 5);
  const risks = dimensions
    .filter((dimension) => dimension.notObserved || (dimension.score ?? 5) <= 2)
    .map((dimension) =>
      dimension.notObserved
        ? `${dimension.label}: not observed in this response; hiring risk remains unvalidated.`
        : `${dimension.label}: score is currently below hiring bar due to weak evidence.`,
    )
    .slice(0, 4);
  const followUps = dimensions.flatMap((dimension) => dimension.probes ?? []).slice(0, 5);

  const mustFixToHire =
    recommendation === "StrongHire" || recommendation === "Hire"
      ? []
      : [
          "Demonstrate the not-observed dimension with one concrete example.",
          "Increase evidence quality by adding measurable outcomes tied to actions.",
        ];

  return {
    overallSummary:
      `Mock hiring-loop summary for "${questionText}": anchored scoring is based on segment-linked evidence and interviewer-style rationale.`,
    overallRecommendation: recommendation,
    risks: ensureMinItems(risks, ["No immediate blockers identified from this single response."], 1, 6),
    followUps: ensureMinItems(
      followUps,
      ["What would you do differently in hindsight, and why?"],
      1,
      6,
    ),
    decisionRationale: [
      `Recommendation ${recommendation} is driven by anchor alignment across observed dimensions.`,
      "Confidence weights evidence quality, cross-segment consistency, and citation coverage.",
      "One dimension is intentionally marked not observed to model realistic interviewer uncertainty.",
    ],
    keyStrengths: ensureMinItems(
      strengths,
      ["Response includes at least one concrete, evidence-backed decision narrative."],
      1,
      5,
    ),
    keyRisks: ensureMinItems(
      risks,
      ["Insufficient behavioral evidence in at least one dimension."],
      1,
      4,
    ),
    mustFixToHire,
  };
}

export function isReportRequestBody(value: unknown): value is ReportRequestBody {
  if (!isRecord(value)) {
    return false;
  }

  if (!isNonEmptyString(value.questionId) || !isNonEmptyString(value.questionText)) {
    return false;
  }

  if (!isRecord(value.rubric) || !Array.isArray(value.rubric.dimensions)) {
    return false;
  }

  const segments = value.segments;
  if (!Array.isArray(segments)) {
    return false;
  }
  const validSegments = segments.every((segment) => {
    if (!isRecord(segment)) {
      return false;
    }
    return (
      isNonEmptyString(segment.id) &&
      typeof segment.start === "number" &&
      Number.isFinite(segment.start) &&
      typeof segment.end === "number" &&
      Number.isFinite(segment.end) &&
      typeof segment.text === "string"
    );
  });
  if (!validSegments) {
    return false;
  }

  return value.rubric.dimensions.every((dimension) => {
    if (!isRecord(dimension)) {
      return false;
    }
    return (
      isNonEmptyString(dimension.key) &&
      isNonEmptyString(dimension.label) &&
      isNonEmptyString(dimension.description)
    );
  });
}

function isLegacyReportResponseBody(value: unknown): value is LegacyReportResponseBody {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.summary !== "string" || !Array.isArray(value.items)) {
    return false;
  }

  return value.items.every((item) => {
    if (!isRecord(item)) {
      return false;
    }
    if (
      !isNonEmptyString(item.dimensionKey) ||
      typeof item.score !== "number" ||
      !Number.isFinite(item.score) ||
      typeof item.claim !== "string" ||
      !Array.isArray(item.evidence)
    ) {
      return false;
    }

    return item.evidence.every((entry) => {
      if (!isRecord(entry)) {
        return false;
      }
      return (
        isNonEmptyString(entry.segmentId) &&
        typeof entry.quote === "string" &&
        typeof entry.confidence === "number" &&
        Number.isFinite(entry.confidence)
      );
    });
  });
}

function isModernDimensionAssessment(value: unknown): value is ReportDimensionAssessment {
  if (!isRecord(value)) {
    return false;
  }

  const scoreIsValid =
    value.score === null ||
    (typeof value.score === "number" &&
      Number.isFinite(value.score) &&
      value.score >= 1 &&
      value.score <= 5);

  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.label) ||
    !scoreIsValid ||
    typeof value.notObserved !== "boolean" ||
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    !isRecord(value.anchors) ||
    !Array.isArray(value.missingSignals) ||
    !Array.isArray(value.evidence) ||
    !isRecord(value.evidenceCoverage)
  ) {
    return false;
  }

  const anchors = value.anchors as UnknownRecord;
  const hasAnchors =
    typeof anchors["1"] === "string" &&
    typeof anchors["2"] === "string" &&
    typeof anchors["3"] === "string" &&
    typeof anchors["4"] === "string" &&
    typeof anchors["5"] === "string";
  if (!hasAnchors) {
    return false;
  }

  const evidenceCoverage = value.evidenceCoverage as UnknownRecord;
  if (
    typeof evidenceCoverage.citedSegmentCount !== "number" ||
    !Number.isFinite(evidenceCoverage.citedSegmentCount) ||
    typeof evidenceCoverage.availableSegmentCount !== "number" ||
    !Number.isFinite(evidenceCoverage.availableSegmentCount)
  ) {
    return false;
  }

  return value.evidence.every((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    return (
      isNonEmptyString(entry.segmentId) &&
      typeof entry.quote === "string" &&
      typeof entry.relevance === "number" &&
      Number.isFinite(entry.relevance)
    );
  });
}

function isCoverageMap(value: unknown): value is ReportCoverageMap {
  if (!isRecord(value)) {
    return false;
  }
  if (!isRecord(value.byDimension) || !isRecord(value.bySegment)) {
    return false;
  }

  const byDimensionValues = Object.values(value.byDimension);
  const bySegmentValues = Object.values(value.bySegment);

  const dimensionsValid = byDimensionValues.every((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    return (
      Array.isArray(entry.segmentIds) &&
      entry.segmentIds.every((segmentId) => typeof segmentId === "string") &&
      typeof entry.coveragePct === "number" &&
      Number.isFinite(entry.coveragePct)
    );
  });
  if (!dimensionsValid) {
    return false;
  }

  return bySegmentValues.every((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    return (
      Array.isArray(entry.dimensions) &&
      entry.dimensions.every((dimensionId) => typeof dimensionId === "string")
    );
  });
}

function isModernReportResponseBody(value: unknown): value is ModernReportResponseBody {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.overallSummary !== "string" ||
    toOverallRecommendation(value.overallRecommendation) === null ||
    !Array.isArray(value.risks) ||
    !Array.isArray(value.followUps) ||
    !Array.isArray(value.dimensions)
  ) {
    return false;
  }

  const baseArraysValid =
    value.risks.every((entry) => typeof entry === "string") &&
    value.followUps.every((entry) => typeof entry === "string");
  if (!baseArraysValid) {
    return false;
  }

  if (!value.dimensions.every((dimension) => isModernDimensionAssessment(dimension))) {
    return false;
  }

  if (value.decisionRationale !== undefined && !Array.isArray(value.decisionRationale)) {
    return false;
  }
  if (value.keyStrengths !== undefined && !Array.isArray(value.keyStrengths)) {
    return false;
  }
  if (value.keyRisks !== undefined && !Array.isArray(value.keyRisks)) {
    return false;
  }
  if (value.mustFixToHire !== undefined && !Array.isArray(value.mustFixToHire)) {
    return false;
  }

  const optionalArrays = [
    value.decisionRationale,
    value.keyStrengths,
    value.keyRisks,
    value.mustFixToHire,
  ];
  const optionalArraysValid = optionalArrays.every((arrayValue) => {
    if (arrayValue === undefined) {
      return true;
    }
    return arrayValue.every((entry) => typeof entry === "string");
  });
  if (!optionalArraysValid) {
    return false;
  }

  if (value.coverageMap !== undefined && !isCoverageMap(value.coverageMap)) {
    return false;
  }

  return true;
}

export function isReportResponseBody(value: unknown): value is ReportResponseBody {
  return isLegacyReportResponseBody(value) || isModernReportResponseBody(value);
}

export function toModernReportResponse(
  report: ReportResponseBody,
  options: NormalizeOptions,
): ModernReportResponseBody {
  if (isLegacyReportResponseBody(report)) {
    return fromLegacyReport(report, options);
  }
  return normalizeModernReport(report, normalizeOptions(options));
}

function normalizeFromUnknown(
  payload: unknown,
  context: NormalizeContext,
): ModernReportResponseBody {
  if (isLegacyReportResponseBody(payload)) {
    return fromLegacyReport(payload, {
      dimensions: context.dimensions,
      availableSegmentCount: context.availableSegmentCount,
      segments: context.segments,
    });
  }
  if (isModernReportResponseBody(payload)) {
    return normalizeModernReport(payload, context);
  }
  if (isRecord(payload)) {
    return normalizeModernReport(payload as Partial<ModernReportResponseBody>, context);
  }
  return createMockReport({
    questionId: "unknown",
    questionText: "Unknown question",
    segments: context.segments,
    rubric: { dimensions: context.dimensions },
  });
}

export function normalizeReportResponse(
  payload: unknown,
  requestBody: ReportRequestBody,
): ModernReportResponseBody {
  const context = normalizedContextFromRequest(requestBody);
  const normalized = normalizeFromUnknown(payload, context);
  return normalizeModernReport(normalized, context);
}

export function createMockReport(requestBody: ReportRequestBody): ModernReportResponseBody {
  const context = normalizedContextFromRequest(requestBody);
  const notObservedIndex =
    context.dimensions.length >= 3 ? context.dimensions.length - 1 : -1;

  const dimensions = context.dimensions.map((descriptor, index) => {
    return createMockDimension(descriptor, index, context, index === notObservedIndex);
  });

  const topLevel = createMockTopLevel(requestBody.questionText, dimensions);
  const coverageMap = createCoverageMap(dimensions, context.segments);

  return {
    overallSummary: topLevel.overallSummary,
    overallRecommendation: topLevel.overallRecommendation,
    risks: topLevel.risks,
    followUps: topLevel.followUps,
    dimensions,
    decisionRationale: topLevel.decisionRationale,
    keyStrengths: topLevel.keyStrengths,
    keyRisks: topLevel.keyRisks,
    mustFixToHire: topLevel.mustFixToHire,
    coverageMap,
  };
}

export function createReportJsonSchema(requestBody: ReportRequestBody): JsonSchemaObject {
  const dimensionKeys = requestBody.rubric.dimensions.map((dimension) => dimension.key);
  const dimensionLabels = requestBody.rubric.dimensions.map((dimension) => dimension.label);
  const segmentIds = requestBody.segments.map((segment) => segment.id);

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      overallSummary: { type: "string", minLength: 1 },
      overallRecommendation: {
        type: "string",
        enum: [...RECOMMENDATIONS],
      },
      risks: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 6,
      },
      followUps: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 6,
      },
      decisionRationale: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 5,
      },
      keyStrengths: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 5,
      },
      keyRisks: {
        type: "array",
        items: { type: "string" },
        minItems: 2,
        maxItems: 4,
      },
      mustFixToHire: {
        type: "array",
        items: { type: "string" },
        minItems: 0,
        maxItems: 4,
      },
      dimensions: {
        type: "array",
        minItems: dimensionKeys.length,
        maxItems: dimensionKeys.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              enum: dimensionKeys,
            },
            label: {
              type: "string",
              enum: dimensionLabels,
            },
            score: {
              type: ["integer", "null"],
              minimum: 1,
              maximum: 5,
            },
            notObserved: { type: "boolean" },
            confidence: {
              type: "integer",
              minimum: 0,
              maximum: 100,
            },
            anchors: {
              type: "object",
              additionalProperties: false,
              properties: {
                "1": { type: "string" },
                "2": { type: "string" },
                "3": { type: "string" },
                "4": { type: "string" },
                "5": { type: "string" },
              },
              required: ["1", "2", "3", "4", "5"],
            },
            missingSignals: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 4,
            },
            observations: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 4,
            },
            anchorAlignment: {
              type: "object",
              additionalProperties: false,
              properties: {
                chosenLevel: { type: "integer", minimum: 1, maximum: 5 },
                whyMeets: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  maxItems: 3,
                },
                whyNotHigher: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  maxItems: 3,
                },
              },
              required: ["chosenLevel", "whyMeets", "whyNotHigher"],
            },
            evidenceQuality: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
            consistency: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
            probes: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 3,
            },
            whatWouldChangeScore: {
              type: "object",
              additionalProperties: false,
              properties: {
                up: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  maxItems: 3,
                },
                down: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  maxItems: 3,
                },
              },
              required: ["up", "down"],
            },
            evidence: {
              type: "array",
              minItems: 0,
              maxItems: 4,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  segmentId: {
                    type: "string",
                    enum: segmentIds,
                  },
                  quote: { type: "string" },
                  relevance: {
                    type: "number",
                    minimum: 0,
                    maximum: 1,
                  },
                },
                required: ["segmentId", "quote", "relevance"],
              },
            },
            evidenceCoverage: {
              type: "object",
              additionalProperties: false,
              properties: {
                citedSegmentCount: { type: "integer", minimum: 0 },
                availableSegmentCount: { type: "integer", minimum: 0 },
              },
              required: ["citedSegmentCount", "availableSegmentCount"],
            },
          },
          required: [
            "id",
            "label",
            "score",
            "notObserved",
            "confidence",
            "anchors",
            "missingSignals",
            "observations",
            "anchorAlignment",
            "evidenceQuality",
            "consistency",
            "probes",
            "whatWouldChangeScore",
            "evidence",
            "evidenceCoverage",
          ],
        },
      },
      coverageMap: {
        type: "object",
        additionalProperties: false,
        properties: {
          byDimension: {
            type: "object",
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              properties: {
                segmentIds: {
                  type: "array",
                  items: { type: "string", enum: segmentIds },
                },
                coveragePct: { type: "number", minimum: 0, maximum: 100 },
              },
              required: ["segmentIds", "coveragePct"],
            },
          },
          bySegment: {
            type: "object",
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              properties: {
                dimensions: {
                  type: "array",
                  items: { type: "string", enum: dimensionKeys },
                },
              },
              required: ["dimensions"],
            },
          },
        },
        required: ["byDimension", "bySegment"],
      },
    },
    required: [
      "overallSummary",
      "overallRecommendation",
      "risks",
      "followUps",
      "decisionRationale",
      "keyStrengths",
      "keyRisks",
      "mustFixToHire",
      "dimensions",
      "coverageMap",
    ],
  };
}
