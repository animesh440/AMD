/**
 * Vigil — Gemini 1.5 Flash Service
 * services/gemini.service.ts
 *
 * Production integration with the Google Generative AI SDK.
 * Accepts a device image + Vertex AI predictions and returns a
 * structured counterfeit risk scorecard.
 */

import {
  GoogleGenAI,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import type { VertexResults } from "./vertexAI.service";

// ─── Interfaces ───

export type RiskSeverity = "high" | "medium" | "low";

export interface RiskFactor {
  severity: RiskSeverity;
  description: string;
}

export interface GeminiScorecard {
  summary: string;
  riskFactors: RiskFactor[];
  recommendation: string;
}

// ─── Client Singleton ───

let _client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (_client) return _client;

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing GEMINI_API_KEY or GOOGLE_AI_API_KEY environment variable."
    );
  }

  _client = new GoogleGenAI({ apiKey });
  return _client;
}

// ─── System Prompt ───

const SYSTEM_PROMPT = `You are a senior Medical Device Counterfeit Detection Expert with 20+ years of
experience in FDA compliance, UDI verification, and supply-chain forensics.

You will receive:
  1. A photograph of a medical device, its packaging, or its labeling.
  2. Structured computer-vision predictions (labels, confidence scores, bounding
     boxes) produced by a Vertex AI Vision pre-scan.

Your task is to produce a JSON risk scorecard that evaluates whether the device
is authentic or potentially counterfeit.

Evaluation criteria (non-exhaustive):
  • UDI barcode validity (GTIN-14 / HIBCC / ICCBBA formatting, check digits)
  • Regulatory marking accuracy (CE, FDA 510(k), ISO 13485 references)
  • Typography & print quality (font consistency, kerning, resolution, bleed)
  • Holographic / tamper-evident seal integrity
  • Color fidelity vs. known authentic reference packaging
  • Lot / serial number formatting and plausibility
  • Manufacturer branding consistency (logo proportions, pantone match)

Respond with **only** a valid JSON object — no markdown fences, no preamble.
The object must match this schema exactly:

{
  "summary": "<string — 2-3 sentence executive summary of authenticity assessment>",
  "riskFactors": [
    {
      "severity": "high" | "medium" | "low",
      "description": "<string — specific, evidence-based finding>"
    }
  ],
  "recommendation": "<string — actionable next-step recommendation>"
}

Rules:
  • Include at least 3 risk factors, each backed by evidence from the image or predictions.
  • Severity levels: "high" = likely counterfeit indicator, "medium" = warrants
    further investigation, "low" = consistent with authentic product.
  • Be precise — cite specific visual features, confidence scores, or regulatory
    standard references (e.g., "FDA 21 CFR 801.20", "EU MDR 2017/745").
  • If the image is too blurry or unrelated, still return valid JSON with an
    appropriate summary and a "high" risk factor noting insufficient evidence.`;

// ─── Scorecard Generation ───

/**
 * Analyze a device image with Gemini 1.5 Flash, combining the raw image
 * and Vertex AI prediction context to produce a risk scorecard.
 *
 * @param base64Image    Base64-encoded image (with or without data URI prefix)
 * @param vertexResults  Output from the Vertex AI Vision analysis step
 * @returns              Structured counterfeit risk scorecard
 */
export async function generateScorecard(
  base64Image: string,
  vertexResults: VertexResults
): Promise<GeminiScorecard> {
  const client = getClient();

  // Build the image part
  const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, "");

  // Infer MIME type from the data URI prefix if present, otherwise default to JPEG
  const mimeMatch = base64Image.match(/^data:(image\/\w+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";

  const imagePart: Part = {
    inlineData: {
      data: cleanBase64,
      mimeType,
    },
  };

  // Build the text context part with Vertex AI predictions
  const predictionSummary = vertexResults.predictions
    .slice(0, 25) // Cap to keep prompt within token budget
    .map(
      (p, i) =>
        `  ${i + 1}. "${p.label}" — confidence: ${(p.score * 100).toFixed(1)}% — region: (x:${p.region.x.toFixed(3)}, y:${p.region.y.toFixed(3)}, w:${p.region.width.toFixed(3)}, h:${p.region.height.toFixed(3)})`
    )
    .join("\n");

  const contextPart: Part = {
    text: `Vertex AI Vision Pre-Scan Results (${vertexResults.predictions.length} detections):\n${predictionSummary}\n\nPlease analyze the attached device image in light of these detections and produce your risk scorecard.`,
  };

  // Call Gemini 1.5 Flash
  const response: GenerateContentResponse = await client.models.generateContent(
    {
      model: "gemini-1.5-flash",
      contents: [
        {
          role: "user",
          parts: [imagePart, contextPart],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.2,       // Low temp for structured, factual output
        topP: 0.8,
        maxOutputTokens: 2048,
        responseMimeType: "application/json", // Force JSON output mode
      },
    }
  );

  // Extract text from response
  const rawText =
    response.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? "";

  if (!rawText.trim()) {
    throw new Error("Gemini returned an empty response.");
  }

  // Parse JSON (strip markdown fences as a safety net)
  const cleaned = rawText
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Failed to parse Gemini response as JSON. Raw output: ${rawText.slice(0, 500)}`
    );
  }

  // Validate shape
  const scorecard = parsed as Record<string, unknown>;

  if (
    typeof scorecard.summary !== "string" ||
    !Array.isArray(scorecard.riskFactors) ||
    typeof scorecard.recommendation !== "string"
  ) {
    throw new Error(
      "Gemini response does not match expected GeminiScorecard schema."
    );
  }

  // Validate each risk factor
  const validSeverities = new Set<string>(["high", "medium", "low"]);
  const riskFactors: RiskFactor[] = scorecard.riskFactors.map(
    (rf: unknown, idx: number) => {
      const factor = rf as Record<string, unknown>;
      if (
        typeof factor.severity !== "string" ||
        !validSeverities.has(factor.severity) ||
        typeof factor.description !== "string"
      ) {
        throw new Error(
          `Invalid risk factor at index ${idx}: ${JSON.stringify(rf)}`
        );
      }
      return {
        severity: factor.severity as RiskSeverity,
        description: factor.description,
      };
    }
  );

  return {
    summary: scorecard.summary as string,
    riskFactors,
    recommendation: scorecard.recommendation as string,
  };
}

// ─── Next.js API Route Handler (App Router) ───

/**
 * Drop-in handler for `app/api/gemini/route.ts`:
 *
 *   import { POST } from "@/services/gemini.service";
 *   export { POST };
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const { image, vertexResults } = body as {
      image?: string;
      vertexResults?: VertexResults;
    };

    if (!image || typeof image !== "string") {
      return Response.json(
        { error: "Missing or invalid `image` field (base64 string expected)." },
        { status: 400 }
      );
    }

    if (!vertexResults || !Array.isArray(vertexResults.predictions)) {
      return Response.json(
        {
          error:
            "Missing or invalid `vertexResults` field (VertexResults object expected).",
        },
        { status: 400 }
      );
    }

    const scorecard = await generateScorecard(image, vertexResults);

    return Response.json(scorecard, { status: 200 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    console.error("[Gemini Service]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
