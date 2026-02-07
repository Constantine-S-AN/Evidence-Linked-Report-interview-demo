import { NextResponse } from "next/server";
import {
  createMockReport,
  createReportJsonSchema,
  isReportRequestBody,
  normalizeReportResponse,
} from "@/lib/report";
import type { ReportRequestBody, ReportResponseBody } from "@/types/report";

export const runtime = "nodejs";

interface ReportErrorResponse {
  error: string;
}

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

function extractCompletionContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const root = payload as Record<string, unknown>;
  if (!Array.isArray(root.choices) || root.choices.length === 0) {
    return null;
  }

  const choice = root.choices[0];
  if (typeof choice !== "object" || choice === null) {
    return null;
  }

  const message = (choice as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    return null;
  }

  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];

    for (const part of content) {
      if (typeof part !== "object" || part === null) {
        continue;
      }
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type !== "text") {
        continue;
      }
      if (typeof partRecord.text === "string") {
        textParts.push(partRecord.text);
      }
    }

    const joined = textParts.join("").trim();
    return joined.length > 0 ? joined : null;
  }

  return null;
}

async function generateReportWithOpenAI(
  requestBody: ReportRequestBody,
  apiKey: string,
): Promise<ReportResponseBody> {
  const schema = createReportJsonSchema(requestBody);

  const prompt = JSON.stringify(
    {
      questionId: requestBody.questionId,
      questionText: requestBody.questionText,
      rubric: requestBody.rubric,
      segments: requestBody.segments,
      instructions: [
        "Return ONLY JSON.",
        "Use each rubric dimension exactly once in dimensions[].",
        "Treat this as a recruiter/hiring-manager scorecard, not generic feedback.",
        "Use concrete, falsifiable language tied to transcript details.",
        "For each dimension include anchors for levels 1 through 5.",
        "A dimension can be notObserved=true with score=null when there is no clear signal.",
        "For observed dimensions, provide 2-4 evidence entries when possible using valid segmentId values.",
        "Each evidence entry must include quote (<=25 words), interpretation, and strength (weak|medium|strong).",
        "Each observedSignals bullet should be supported by at least one cited segmentId unless notObserved=true.",
        "Include concerns (1-3) and optionally counterSignals for each dimension.",
        "Use scorecard language: observed signals, concerns, rationale, and follow-up probes.",
        "Provide anchorAlignment fields with chosenLevel, whyMeets, and whyNotHigher.",
        "Provide 2-4 concise observedSignals and 2-3 probes per dimension.",
        "Set evidenceQuality and consistency between 0 and 1.",
        "confidence must be 0-100 and should be explainable from evidenceCoverage, evidenceQuality, and consistency.",
        "Populate coverageMap.byDimension and coverageMap.bySegment from the cited evidence segmentIds.",
        "Set overallRecommendation to one of StrongHire, Hire, LeanHire, LeanNo, No.",
        "Include top-level decisionRationale, leveling, calibrationNotes, keyStrengths, keyRisks, and mustFixToHire.",
      ],
    },
    null,
    2,
  );

  const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You generate evidence-linked interview reports and must return strict JSON matching the provided schema exactly.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "evidence_linked_report",
          strict: true,
          schema,
        },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI report generation failed (${response.status}): ${errorText.slice(0, 300)}`);
  }

  const payload: unknown = await response.json();
  const rawContent = extractCompletionContent(payload);
  if (!rawContent) {
    throw new Error("OpenAI response did not include JSON content.");
  }

  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(rawContent);
  } catch {
    throw new Error("OpenAI returned invalid JSON for report generation.");
  }

  return normalizeReportResponse(parsedContent, requestBody);
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const forceMockMode = url.searchParams.get("mock") === "1";

  let requestBodyUnknown: unknown;
  try {
    requestBodyUnknown = await request.json();
  } catch {
    return NextResponse.json<ReportErrorResponse>({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isReportRequestBody(requestBodyUnknown)) {
    return NextResponse.json<ReportErrorResponse>(
      { error: "Invalid request body for /api/report." },
      { status: 400 },
    );
  }

  const requestBody = requestBodyUnknown;

  if (requestBody.segments.length === 0) {
    return NextResponse.json<ReportErrorResponse>(
      { error: "segments must contain at least one transcript segment." },
      { status: 400 },
    );
  }

  if (requestBody.rubric.dimensions.length === 0) {
    return NextResponse.json<ReportErrorResponse>(
      { error: "rubric.dimensions must contain at least one dimension." },
      { status: 400 },
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (forceMockMode || !apiKey) {
    return NextResponse.json<ReportResponseBody>(createMockReport(requestBody));
  }

  try {
    const report = await generateReportWithOpenAI(requestBody, apiKey);
    return NextResponse.json<ReportResponseBody>(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate report.";
    return NextResponse.json<ReportErrorResponse>({ error: message }, { status: 500 });
  }
}
