import type { InterviewRecording } from "@/types/interview";

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface TranscribeResponse {
  transcriptText: string;
  segments: TranscriptSegment[];
}

function getFileExtensionFromMimeType(mimeType: string): string {
  if (mimeType.includes("ogg")) {
    return "ogg";
  }
  if (mimeType.includes("mp4")) {
    return "m4a";
  }
  if (mimeType.includes("mpeg")) {
    return "mp3";
  }
  return "webm";
}

function decodeBase64(base64Data: string): ArrayBuffer {
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);

  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes.buffer;
}

export function recordingToFile(recording: InterviewRecording): File {
  const extension = getFileExtensionFromMimeType(recording.mimeType);
  const buffer = decodeBase64(recording.data);
  const blob = new Blob([buffer], { type: recording.mimeType });
  return new File([blob], `question-${recording.questionId}.${extension}`, {
    type: recording.mimeType,
  });
}
