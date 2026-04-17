/**
 * Vigil — Vertex AI Vision Service
 * services/vertexAI.service.ts
 *
 * Production integration with Google Cloud Vision API.
 * Analyzes device images for text, logos, objects, and barcodes,
 * returning normalized bounding-box predictions.
 */

import { ImageAnnotatorClient, protos } from "@google-cloud/vision";

// ─── Interfaces ───

export interface PredictionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Prediction {
  label: string;
  score: number;
  region: PredictionRegion;
}

export interface VertexResults {
  predictions: Prediction[];
}

// ─── Auth Helper ───

function getVisionClient(): ImageAnnotatorClient {
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (credentialsJson) {
    // Parse inline service-account JSON (typical for serverless / Vercel)
    const credentials = JSON.parse(credentialsJson);
    return new ImageAnnotatorClient({ credentials });
  }

  // Fall back to ADC (GOOGLE_APPLICATION_CREDENTIALS file path, Workload Identity, etc.)
  return new ImageAnnotatorClient();
}

// ─── Vertex Normalization Helpers ───

type IVertex = protos.google.cloud.vision.v1.IVertex;
type IBoundingPoly = protos.google.cloud.vision.v1.IBoundingPoly;

/**
 * Convert a Vision API BoundingPoly (array of vertices) into a
 * normalized { x, y, width, height } rectangle (0-1 range).
 */
function normalizeVertices(
  boundingPoly: IBoundingPoly | null | undefined,
  imageWidth: number,
  imageHeight: number
): PredictionRegion {
  if (!boundingPoly) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  // Prefer normalizedVertices (already 0-1); fall back to pixel vertices.
  const vertices: Array<{ x: number; y: number }> =
    boundingPoly.normalizedVertices?.length
      ? boundingPoly.normalizedVertices.map((v) => ({
          x: v.x ?? 0,
          y: v.y ?? 0,
        }))
      : (boundingPoly.vertices ?? []).map((v: IVertex) => ({
          x: imageWidth > 0 ? (v.x ?? 0) / imageWidth : 0,
          y: imageHeight > 0 ? (v.y ?? 0) / imageHeight : 0,
        }));

  if (vertices.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const xs = vertices.map((v) => v.x);
  const ys = vertices.map((v) => v.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

// ─── Main Analysis Function ───

/**
 * Analyze a base64-encoded image using the Google Cloud Vision API.
 *
 * Runs four detection features in a single request:
 *   • TEXT_DETECTION   — printed / handwritten text
 *   • LOGO_DETECTION   — brand & regulatory logos
 *   • OBJECT_LOCALIZATION — physical objects
 *   • PRODUCT_SEARCH (fallback to LABEL_DETECTION) — supplementary context
 *
 * @param base64Image  Base64-encoded image (with or without data URI prefix)
 * @returns            Unified prediction array with bounding boxes
 */
export async function analyzeDeviceImage(
  base64Image: string
): Promise<VertexResults> {
  const client = getVisionClient();

  // Strip optional data URI prefix
  const rawBase64 = base64Image.replace(/^data:image\/\w+;base64,/, "");

  // Build a single annotateImage request with multiple features
  const request: protos.google.cloud.vision.v1.IAnnotateImageRequest = {
    image: { content: rawBase64 },
    features: [
      { type: "TEXT_DETECTION", maxResults: 30 },
      { type: "LOGO_DETECTION", maxResults: 10 },
      { type: "OBJECT_LOCALIZATION", maxResults: 20 },
      { type: "LABEL_DETECTION", maxResults: 10 },
    ],
    imageContext: {
      languageHints: ["en"],
    },
  };

  const [result] = await client.annotateImage(request);

  if (result.error?.message) {
    throw new Error(`Vision API error: ${result.error.message}`);
  }

  const predictions: Prediction[] = [];

  // Determine source image dimensions (from fullTextAnnotation pages, if available)
  const page = result.fullTextAnnotation?.pages?.[0];
  const imgW = page?.width ?? 0;
  const imgH = page?.height ?? 0;

  // ── Text detections (skip the first element — it's the full text block) ──
  const textAnnotations = result.textAnnotations?.slice(1) ?? [];
  for (const t of textAnnotations) {
    predictions.push({
      label: t.description ?? "text",
      score: t.confidence ?? 0.9,
      region: normalizeVertices(t.boundingPoly, imgW, imgH),
    });
  }

  // ── Logo detections ──
  for (const logo of result.logoAnnotations ?? []) {
    predictions.push({
      label: logo.description ?? "logo",
      score: logo.score ?? 0.8,
      region: normalizeVertices(logo.boundingPoly, imgW, imgH),
    });
  }

  // ── Localized object detections (already supply normalizedVertices) ──
  for (const obj of result.localizedObjectAnnotations ?? []) {
    const bp = obj.boundingPoly;
    const nv = bp?.normalizedVertices ?? [];
    let region: PredictionRegion = { x: 0, y: 0, width: 0, height: 0 };

    if (nv.length >= 4) {
      const xs = nv.map((v) => v.x ?? 0);
      const ys = nv.map((v) => v.y ?? 0);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      region = {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
      };
    }

    predictions.push({
      label: obj.name ?? "object",
      score: obj.score ?? 0.7,
      region,
    });
  }

  // ── Label detections (image-level — no bounding box) ──
  for (const label of result.labelAnnotations ?? []) {
    predictions.push({
      label: label.description ?? "label",
      score: label.score ?? 0.5,
      region: { x: 0, y: 0, width: 1, height: 1 }, // full-image
    });
  }

  // Sort by confidence descending
  predictions.sort((a, b) => b.score - a.score);

  return { predictions };
}

// ─── Next.js API Route Handler (App Router) ───

/**
 * Drop-in handler for `app/api/vision/route.ts`:
 *
 *   import { POST } from "@/services/vertexAI.service";
 *   export { POST };
 *
 * Or re-export after adding middleware (auth, rate-limiting, etc.).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const { image } = body as { image?: string };

    if (!image || typeof image !== "string") {
      return Response.json(
        { error: "Missing or invalid `image` field (base64 string expected)." },
        { status: 400 }
      );
    }

    const results = await analyzeDeviceImage(image);

    return Response.json(results, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[VertexAI Service]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
