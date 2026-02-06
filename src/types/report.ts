export interface EvidenceSpan {
  id: string;
  claim: string;
  sourceText: string;
  startChar: number;
  endChar: number;
  confidence: number;
}

export interface TranscriptSegment {
  id: string;
  speaker: "interviewer" | "candidate";
  text: string;
  startMs: number;
  endMs: number;
  evidenceSpans?: EvidenceSpan[];
}

export interface ReportInputSegment {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface ReportDimension {
  key: string;
  label: string;
  description: string;
}

export interface ReportRubric {
  dimensions: ReportDimension[];
}

export interface ReportRequestBody {
  questionId: string;
  questionText: string;
  segments: ReportInputSegment[];
  rubric: ReportRubric;
}

export interface ReportEvidence {
  segmentId: string;
  quote: string;
  confidence: number;
}

export interface ReportItem {
  dimensionKey: string;
  score: number;
  claim: string;
  evidence: ReportEvidence[];
}

export interface LegacyReportResponseBody {
  summary: string;
  items: ReportItem[];
}

export type OverallRecommendation = "StrongHire" | "Hire" | "LeanHire" | "LeanNo" | "No";

export interface ReportAnchors {
  "1": string;
  "2": string;
  "3": string;
  "4": string;
  "5": string;
}

export interface ReportDimensionEvidence {
  segmentId: string;
  quote: string;
  relevance: number;
}

export interface ReportEvidenceCoverage {
  citedSegmentCount: number;
  availableSegmentCount: number;
}

export interface ReportAnchorAlignment {
  chosenLevel: number;
  whyMeets: string[];
  whyNotHigher: string[];
}

export interface ReportWhatWouldChangeScore {
  up: string[];
  down: string[];
}

export interface ReportCoverageByDimensionEntry {
  segmentIds: string[];
  coveragePct: number;
}

export interface ReportCoverageBySegmentEntry {
  dimensions: string[];
}

export interface ReportCoverageMap {
  byDimension: Record<string, ReportCoverageByDimensionEntry>;
  bySegment: Record<string, ReportCoverageBySegmentEntry>;
}

export interface ReportDimensionAssessment {
  id: string;
  label: string;
  score: number | null;
  notObserved: boolean;
  confidence: number;
  anchors: ReportAnchors;
  missingSignals: string[];
  evidence: ReportDimensionEvidence[];
  evidenceCoverage: ReportEvidenceCoverage;
  observations?: string[];
  anchorAlignment?: ReportAnchorAlignment;
  evidenceQuality?: number;
  consistency?: number;
  probes?: string[];
  whatWouldChangeScore?: ReportWhatWouldChangeScore;
}

export interface ModernReportResponseBody {
  overallSummary: string;
  overallRecommendation: OverallRecommendation;
  risks: string[];
  followUps: string[];
  dimensions: ReportDimensionAssessment[];
  decisionRationale?: string[];
  keyStrengths?: string[];
  keyRisks?: string[];
  mustFixToHire?: string[];
  coverageMap?: ReportCoverageMap;
}

export type ReportResponseBody = ModernReportResponseBody | LegacyReportResponseBody;
