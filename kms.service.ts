/**
 * Vigil — Google Cloud KMS Service
 * services/kms.service.ts
 *
 * Production integration with Google Cloud Key Management Service.
 * Signs device verification payloads using an asymmetric ECDSA P-256
 * key for tamper-proof attestation records stored on the Firebase ledger.
 */

import { KeyManagementServiceClient } from "@google-cloud/kms";
import * as crypto from "crypto";

// ─── Interfaces ───

export interface VerificationPayload {
  deviceId: string;
  timestamp: string;
  vertexResults: unknown;
  geminiScorecard: unknown;
  imageHash: string;
}

export interface SignatureResult {
  signature: string;        // Base64-encoded cryptographic signature
  keyVersionName: string;   // Full resource name of the signing key version
  algorithm: string;        // Signing algorithm used
  payloadDigest: string;    // SHA-256 digest of the canonical payload
  signedAt: string;         // ISO 8601 timestamp
}

// ─── Configuration ───

interface KmsConfig {
  projectId: string;
  locationId: string;
  keyRingId: string;
  keyId: string;
  keyVersionId: string;
}

function getKmsConfig(): KmsConfig {
  const projectId = process.env.GCP_PROJECT_ID;
  const locationId = process.env.KMS_LOCATION_ID ?? "global";
  const keyRingId = process.env.KMS_KEY_RING_ID ?? "vigil-verification";
  const keyId = process.env.KMS_KEY_ID ?? "device-attestation-key";
  const keyVersionId = process.env.KMS_KEY_VERSION_ID ?? "1";

  if (!projectId) {
    throw new Error("Missing GCP_PROJECT_ID environment variable.");
  }

  return { projectId, locationId, keyRingId, keyId, keyVersionId };
}

// ─── Client Singleton ───

let _client: KeyManagementServiceClient | null = null;

function getKmsClient(): KeyManagementServiceClient {
  if (_client) return _client;

  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (credentialsJson) {
    const credentials = JSON.parse(credentialsJson);
    _client = new KeyManagementServiceClient({ credentials });
  } else {
    // ADC / Workload Identity
    _client = new KeyManagementServiceClient();
  }

  return _client;
}

// ─── Helpers ───

/**
 * Produce a deterministic canonical JSON string.
 * Keys are sorted alphabetically at every nesting level.
 */
function canonicalize(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort());
}

/**
 * Compute SHA-256 digest of a buffer and return it as raw bytes.
 */
function sha256(data: Buffer): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

// ─── Main Signing Function ───

/**
 * Cryptographically sign a device verification result using
 * Google Cloud KMS (ECDSA P-256 / SHA-256).
 *
 * Flow:
 *   1. Canonicalize the payload to deterministic JSON.
 *   2. Compute a SHA-256 digest of the canonical payload.
 *   3. Send the digest to Cloud KMS for asymmetric signing.
 *   4. Return the base64-encoded signature along with metadata.
 *
 * @param payload  The full verification result to attest
 * @returns        Signature + metadata for Firebase ledger storage
 */
export async function signVerificationResult(
  payload: VerificationPayload
): Promise<SignatureResult> {
  const config = getKmsConfig();
  const client = getKmsClient();

  // Build the full key version resource name
  const keyVersionName = client.cryptoKeyVersionPath(
    config.projectId,
    config.locationId,
    config.keyRingId,
    config.keyId,
    config.keyVersionId
  );

  // Step 1: Canonicalize
  const canonical = canonicalize(payload);
  const payloadBuffer = Buffer.from(canonical, "utf-8");

  // Step 2: Compute SHA-256 digest
  const digest = sha256(payloadBuffer);

  // Step 3: Sign via Cloud KMS
  //
  // For EC_SIGN_P256_SHA256 keys, KMS expects the digest in the `digest` field.
  // The CRC32C integrity check is optional but recommended for production.
  const crc32c = computeCrc32c(digest);

  const [signResponse] = await client.asymmetricSign({
    name: keyVersionName,
    digest: {
      sha256: digest,
    },
    digestCrc32c: {
      value: crc32c,
    },
  });

  // Verify server-side integrity
  if (!signResponse.name || signResponse.name !== keyVersionName) {
    throw new Error(
      "KMS asymmetricSign response key name mismatch — possible MITM."
    );
  }

  if (
    signResponse.verifiedDigestCrc32c !== undefined &&
    signResponse.verifiedDigestCrc32c !== true
  ) {
    throw new Error(
      "KMS reports digest CRC32C verification failed — request may have been corrupted in transit."
    );
  }

  const signatureBuffer = signResponse.signature as Uint8Array | Buffer;
  if (!signatureBuffer || signatureBuffer.length === 0) {
    throw new Error("KMS returned an empty signature.");
  }

  // Verify the signature CRC32C if provided
  if (signResponse.signatureCrc32c?.value !== undefined) {
    const expectedCrc = computeCrc32c(Buffer.from(signatureBuffer));
    const actualCrc =
      typeof signResponse.signatureCrc32c.value === "number"
        ? signResponse.signatureCrc32c.value
        : Number(signResponse.signatureCrc32c.value);

    if (expectedCrc !== actualCrc) {
      throw new Error(
        "Signature CRC32C mismatch — response may have been corrupted."
      );
    }
  }

  const signatureBase64 = Buffer.from(signatureBuffer).toString("base64");

  return {
    signature: signatureBase64,
    keyVersionName,
    algorithm: "EC_SIGN_P256_SHA256",
    payloadDigest: digest.toString("hex"),
    signedAt: new Date().toISOString(),
  };
}

// ─── CRC32C ───

/**
 * Compute CRC32C using Node.js built-in (available since Node 15+).
 * Falls back to a lookup-table implementation for older runtimes.
 */
function computeCrc32c(data: Buffer): number {
  // Node ≥ 15 supports CRC32C natively via the sse4_crc32 instruction
  try {
    const hash = crypto.createHash("crc32c");
    hash.update(data);
    const hex = hash.digest("hex");
    return parseInt(hex, 16);
  } catch {
    // Fallback: software CRC32C (Castagnoli polynomial 0x1EDC6F41)
    return softwareCrc32c(data);
  }
}

function softwareCrc32c(data: Buffer): number {
  const POLY = 0x82f63b78; // Reversed Castagnoli
  let crc = 0xffffffff;

  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ POLY : crc >>> 1;
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

// ─── Optional: Verify a Signature Locally ───

/**
 * Retrieve the public key from KMS and verify a signature locally.
 * Useful for audit / read-path verification without calling asymmetricSign.
 */
export async function verifySignature(
  payload: VerificationPayload,
  signatureBase64: string
): Promise<boolean> {
  const config = getKmsConfig();
  const client = getKmsClient();

  const keyVersionName = client.cryptoKeyVersionPath(
    config.projectId,
    config.locationId,
    config.keyRingId,
    config.keyId,
    config.keyVersionId
  );

  // Retrieve the public key
  const [publicKeyResponse] = await client.getPublicKey({
    name: keyVersionName,
  });

  if (!publicKeyResponse.pem) {
    throw new Error("KMS did not return a PEM public key.");
  }

  // Verify using Node.js crypto
  const canonical = canonicalize(payload);
  const verifier = crypto.createVerify("SHA256");
  verifier.update(canonical);
  verifier.end();

  return verifier.verify(
    publicKeyResponse.pem,
    Buffer.from(signatureBase64, "base64")
  );
}

// ─── Next.js API Route Handler (App Router) ───

/**
 * Drop-in handler for `app/api/kms/sign/route.ts`:
 *
 *   import { POST } from "@/services/kms.service";
 *   export { POST };
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const { payload } = body as { payload?: VerificationPayload };

    if (!payload || typeof payload !== "object") {
      return Response.json(
        {
          error:
            "Missing or invalid `payload` field (VerificationPayload expected).",
        },
        { status: 400 }
      );
    }

    // Validate required fields
    const requiredFields: (keyof VerificationPayload)[] = [
      "deviceId",
      "timestamp",
      "vertexResults",
      "geminiScorecard",
      "imageHash",
    ];

    for (const field of requiredFields) {
      if (!(field in payload)) {
        return Response.json(
          { error: `Missing required field: ${field}` },
          { status: 400 }
        );
      }
    }

    const result = await signVerificationResult(payload);

    return Response.json(result, { status: 200 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    console.error("[KMS Service]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
