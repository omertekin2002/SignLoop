# SignLoop

A contract analysis web app that lets users upload contracts, extract text from documents, and run AI-powered risk analysis with structured findings.

## Features

- Contract upload with PDF, image, and text extraction (OCR fallback via Tesseract.js)
- AI-driven analysis producing risk badges, red flags, key dates, cancellation terms, and suggested actions
- Project-based organization for grouping contracts and context documents
- Authentication via Clerk
- Storage with Vercel Postgres + Vercel Blob

## Tech Stack

- **Framework**: Next.js 16 (App Router) + React 19
- **Language**: TypeScript
- **Styling**: Tailwind CSS + Radix UI
- **AI**: OpenAI SDK with configurable LLM providers
- **Database**: Vercel Postgres
- **Storage**: Vercel Blob (local filesystem fallback for dev)
- **Auth**: Clerk
- **Monorepo**: Turborepo with bun

## Getting Started

```bash
bun install
bun run dev
```

Web app runs on [localhost:3000](http://localhost:3000), See `.env.local` for required environment variables.
