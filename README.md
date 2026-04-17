# 👁️ Vigil: Medical Device Verification Platform

Vigil is an AI-powered counterfeit detection and supply-chain verification platform for medical devices. Built with a dark, ultra-fluid aesthetic, it combines advanced multi-modal visual analysis with immutable cryptographic signatures.

![Vigil Preview](https://vigil-jtdbhyt0u-animeshs-projects-f88fd4a0.vercel.app/favicon.ico)

## ✨ Core Features

*   **Vertex AI Vision Detections**: Multi-modal object detection that automatically targets UDI barcodes, regulatory marks (CE, FDA), and typography rendering at a sub-pixel level to detect anomalies.
*   **Gemini 1.5 Forensic Scorecards**: An expert-level LLM synthesizer that evaluates the raw packaging image alongside Vertex AI bounding boxes to produce specific, actionable risk assessments backed by regulatory citations.
*   **Cloud KMS Attestation**: Every successful verification is run through Google Cloud Key Management Service using an ECDSA P-256 key, establishing a tamper-proof cryptographic attestation signature.
*   **Next.js Frontend Architecture**: Fluid animations, seamless drag-and-drop file support, and an Alcove-inspired dark design system without heavy lifting.

## 🛠 Tech Stack

*   **Framework**: Next.js (App Router)
*   **Language**: TypeScript / JavaScript (React)
*   **AI/ML**: Google Gen AI SDK (`@google/genai`), Vertex AI (`@google-cloud/vision`)
*   **Security**: Google Cloud KMS (`@google-cloud/kms`)
*   **Design**: Vanilla CSS & custom SVG layouts

## 🚀 Getting Started

### 1. Configure the Environment
Copy the `.env.local` template and supply your credentials:

\`\`\`bash
# 1. Gemini
GEMINI_API_KEY=your_gemini_api_key_here

# 2. Google Cloud (Minified Service Account JSON)
GOOGLE_APPLICATION_CREDENTIALS_JSON={"type":"service_account","project_id":"your-project","private_key":"..."}

# 3. KMS Configuration (if overriding defaults)
GCP_PROJECT_ID=your-project-id
\`\`\`

### 2. Install and Run
\`\`\`bash
npm install
npm run dev
\`\`\`
Open [http://localhost:3000](http://localhost:3000) to view the application in your browser.

## 🔒 Security Notice
Do **NOT** commit your `.env.local` file to version control. This project is configured to safely ignore it by default via `.gitignore`.
