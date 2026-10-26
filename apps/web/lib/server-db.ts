import { CONTRACT_ANALYSIS_LIMIT, CONTRACT_HEAD_LENGTH, CONTRACT_TAIL_LENGTH, MAX_EVIDENCE_QUOTE, SOURCE_PAGE_SIZE, type SourceCitation } from "@/lib/source-citations";
import { parseContractEvidence, validateContractReplay, STALE_CONTRACT_REPLY, type ContractEvidence, type CurrentContractRevision } from "@/lib/contract-evidence";
import {
  compactAgentMessages,
  parseAgentMessages,
  parseWebSources,
  MAX_AGENT_STATE_CHARACTERS,
  MAX_SOURCE_CATALOG_CHARACTERS,
} from "@repo/chat-engine/chat-agent-history";
import { runMigrations } from "../db/migrations.js";
import { sql, type VercelPoolClient } from "@vercel/postgres";
import { randomInt, randomUUID } from "node:crypto";
import {
  admissionLimits,
  type AccountQuota,
  type AdmissionLimits,
  type AdmissionReason,
  type AdmissionResult,
  type InferenceQuota,
} from "@/lib/inference-policy";
import type { PrimaryModel } from "@/lib/model-settings";
import type { PersonalityMode } from "@/lib/personality-settings";
import { parseChatFileInfos, savedChatFile, type ChatDocument, type ChatFileInfo } from "@/lib/chat-files-shared";
import type { GeneratedChatFile } from "@/lib/chat-file-generation";
import {
  ChatThreadNotFoundError,
  ContractRevisionChangedError,
  ProjectNotFoundError,
} from "@/lib/errors";

type JsonObject = Record<string, unknown>;

// Match PostgreSQL's UUID casing when building text keys or comparing returned IDs.
// Owner IDs are case-sensitive text and must not pass through this helper.
function canonicalUuid(id: string): string {
  return id.toLowerCase();
}

export async function claimGenerationOperation(
  userId: string,
  kind: "contract" | "chat",
  id: string,
  seconds: number,
): Promise<(() => Promise<void>) | null> {
  await ensureSchema();
  const entityKey = `${kind}:${userId}:${canonicalUuid(id)}`;
  const token = randomUUID();
  const { rowCount } = await sql.query(
    `INSERT INTO generation_operations(entity_key, token, expires_at)
     VALUES ($1, $2, clock_timestamp() + $3 * interval '1 second')
     ON CONFLICT (entity_key) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
     WHERE generation_operations.expires_at < clock_timestamp() RETURNING token`,
    [entityKey, token, seconds],
  );
  if (!rowCount) return null;
  return async () => {
    await sql.query(
      "DELETE FROM generation_operations WHERE entity_key = $1 AND token = $2",
      [entityKey, token],
    );
  };
}

// Admission windows: a clock hour per principal and a UTC day service-wide. Claims and quota reports
// read the same state query below, so a report always sees the windows and live slots a claim would.
const HOUR_WINDOW = "date_trunc('hour', now())";
const DAY_WINDOW =
  "(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')";

// Expired slots are excluded here as well as pruned by claims. Epochs are float8 so they arrive as
// numbers; '24 hours' rather than '1 day' keeps the day reset independent of the session time zone.
const ADMISSION_STATE_SQL = `
  SELECT (SELECT count(*)::integer FROM chat_admissions WHERE expires_at > now()) AS active,
    (SELECT count(*)::integer FROM chat_admissions WHERE principal = $1 AND expires_at > now()) AS own,
    coalesce((SELECT requests FROM chat_request_budgets WHERE bucket = 'global' AND window_start = ${DAY_WINDOW}), 0) AS daily,
    coalesce((SELECT requests FROM chat_request_budgets WHERE bucket = $1 AND window_start = ${HOUR_WINDOW}), 0) AS hourly,
    extract(epoch FROM now())::float8 AS "dbNow",
    extract(epoch FROM ${HOUR_WINDOW} + interval '1 hour')::float8 AS "hourResetsAt",
    extract(epoch FROM ${DAY_WINDOW} + interval '24 hours')::float8 AS "dayResetsAt",
    extract(epoch FROM (SELECT min(expires_at) FROM chat_admissions WHERE principal = $1 AND expires_at > now()))::float8 AS "ownSlotFreesAt",
    extract(epoch FROM (SELECT min(expires_at) FROM chat_admissions WHERE expires_at > now()))::float8 AS "anySlotFreesAt"`;

type AdmissionState = {
  active: number;
  own: number;
  daily: number;
  hourly: number;
  dbNow: number;
  hourResetsAt: number;
  dayResetsAt: number;
  ownSlotFreesAt: number | null;
  anySlotFreesAt: number | null;
};

async function readAdmissionState(
  principal: string,
  client?: VercelPoolClient,
): Promise<AdmissionState> {
  const { rows } = await (client ?? sql).query<AdmissionState>(
    ADMISSION_STATE_SQL,
    [principal],
  );
  return rows[0]!;
}

function epochToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function toAccountQuota(
  state: AdmissionState,
  limits: AdmissionLimits,
  claimed = 0,
): AccountQuota {
  const used = state.hourly + claimed;
  return {
    limit: limits.hourlyLimit,
    used,
    remaining: Math.max(0, limits.hourlyLimit - used),
    resetAt: epochToIso(state.hourResetsAt),
    concurrency: { limit: limits.concurrency, inUse: state.own + claimed },
  };
}

// Slots normally free when their request finishes, so a concurrency rejection suggests a short
// wait, or less when an abandoned slot expires sooner. Jitter spreads the retries.
const BUSY_RETRY_SECONDS = 30;
const RETRY_JITTER_SECONDS = 15;

function admissionRejection(
  state: AdmissionState,
  limits: AdmissionLimits,
): { reason: AdmissionReason; resetsAt: number } | null {
  if (state.daily >= limits.globalDailyLimit)
    return { reason: "daily", resetsAt: state.dayResetsAt };
  if (state.hourly >= limits.hourlyLimit)
    return { reason: "hourly", resetsAt: state.hourResetsAt };
  const ownFull = state.own >= limits.concurrency;
  if (!ownFull && state.active < limits.globalConcurrency) return null;
  // Freeing one of the caller's own slots also frees a global one; otherwise any slot will do.
  const slotFreesAt = ownFull ? state.ownSlotFreesAt : state.anySlotFreesAt;
  return {
    reason: "busy",
    resetsAt: Math.min(
      state.dbNow + BUSY_RETRY_SECONDS,
      slotFreesAt ?? Number.POSITIVE_INFINITY,
    ),
  };
}

export async function claimChatAdmission(
  limits: AdmissionLimits,
): Promise<AdmissionResult> {
  await ensureSchema();
  const client = await sql.connect();
  const token = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(736194822)");
    await client.query("DELETE FROM chat_admissions WHERE expires_at <= now()");
    await client.query(
      "DELETE FROM chat_request_budgets WHERE window_start < now() - interval '2 days'",
    );
    const state = await readAdmissionState(limits.principal, client);
    const rejection = admissionRejection(state, limits);
    if (rejection) {
      await client.query("ROLLBACK");
      return {
        retryAfter:
          Math.max(1, Math.ceil(rejection.resetsAt - state.dbNow)) +
          randomInt(RETRY_JITTER_SECONDS + 1),
        reason: rejection.reason,
        resetAt: epochToIso(rejection.resetsAt),
        quota: toAccountQuota(state, limits),
      };
    }
    await client.query(
      `INSERT INTO chat_request_budgets(bucket, window_start, requests)
      VALUES ('global', ${DAY_WINDOW}, 1), ($1, ${HOUR_WINDOW}, 1)
      ON CONFLICT (bucket, window_start) DO UPDATE SET requests = chat_request_budgets.requests + 1`,
      [limits.principal],
    );
    await client.query(
      "INSERT INTO chat_admissions(token, principal, expires_at) VALUES ($1, $2, now() + interval '360 seconds')",
      [token, limits.principal],
    );
    await client.query("COMMIT");
    return {
      release: async () => {
        await sql.query("DELETE FROM chat_admissions WHERE token = $1", [
          token,
        ]);
      },
      quota: toAccountQuota(state, limits, 1),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Report a signed-in account's quota without claiming any: one pooled read of the claim's state
 * query, with no admission lock and no writes. Service-wide counts only decide the coarse status
 * and are never returned.
 */
export async function getInferenceQuota(
  userId: string,
): Promise<InferenceQuota> {
  await ensureSchema();
  const limits = admissionLimits(userId);
  const state = await readAdmissionState(limits.principal);
  return {
    account: toAccountQuota(state, limits),
    service:
      state.daily >= limits.globalDailyLimit
        ? "exhausted"
        : state.active >= limits.globalConcurrency
          ? "busy"
          : "ok",
  };
}

export async function claimStorageDeletions(limit = 20) {
  await ensureSchema();
  const token = randomUUID();
  return (
    await sql<{ id: string; storageKey: string; token: string }>`
    WITH pending AS (
      SELECT id FROM storage_deletions WHERE available_at <= now()
        AND (lease_until IS NULL OR lease_until <= now())
      ORDER BY available_at, created_at, id LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))} FOR UPDATE SKIP LOCKED
    ) UPDATE storage_deletions d SET lease_token = ${token}, lease_until = now() + interval '15 minutes'
      FROM pending WHERE d.id = pending.id
      RETURNING d.id, d.storage_key AS "storageKey", d.lease_token AS token
  `
  ).rows;
}

export async function deferStorageDeletion(id: string, token: string) {
  await sql`UPDATE storage_deletions SET attempts = attempts + 1,
    available_at = now() + least(86400, 60 * power(2, least(attempts, 11))) * interval '1 second',
    lease_token = NULL, lease_until = NULL WHERE id = ${id} AND lease_token = ${token}`;
}

/** Register before writing bytes, so failed persistence still leaves a durable cleanup intent. */
export async function createUploadCleanupIntent(storageKey: string) {
  await ensureSchema();
  const { rows } = await sql<{
    id: string;
  }>`INSERT INTO storage_deletions(storage_key, available_at)
    VALUES (${storageKey}, now() + interval '1 hour') RETURNING id`;
  return rows[0]!.id;
}

export async function completeStorageDeletion(id: string, token: string) {
  await sql`DELETE FROM storage_deletions WHERE id = ${id} AND lease_token = ${token}`;
}

export type PaginationOptions = {
  limit?: number;
  offset?: number;
};

export type PaginatedResult<T> = {
  data: T[];
  total: number;
  limit: number;
  offset: number;
};

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MAX_PAGE_OFFSET = 1_000_000;

function clampPagination(opts?: PaginationOptions): {
  limit: number;
  offset: number;
} {
  // Number.isFinite guards against NaN (e.g. ?limit=abc -> Number(...) === NaN), which the
  // `?? DEFAULT` nullish coalescing does not catch and would otherwise reach the SQL LIMIT.
  const rawLimit = Number.isFinite(opts?.limit)
    ? Math.trunc(opts!.limit as number)
    : DEFAULT_PAGE_LIMIT;
  const rawOffset = Number.isFinite(opts?.offset)
    ? Math.trunc(opts!.offset as number)
    : 0;
  const limit = Math.min(Math.max(rawLimit, 1), MAX_PAGE_LIMIT);
  const offset = Math.min(Math.max(rawOffset, 0), MAX_PAGE_OFFSET);
  return { limit, offset };
}

let schemaReadyPromise: Promise<void> | null = null;

// Runtime setup and the deployment command execute the same versioned migrations.
export async function ensureSchema(): Promise<void> {
  if (process.env.SKIP_SCHEMA_BOOTSTRAP === "1") return;
  schemaReadyPromise ??= (async () => {
    const client = await sql.connect();
    try {
      await runMigrations(client);
    } finally {
      client.release();
    }
  })().catch((error) => {
    schemaReadyPromise = null;
    throw error;
  });
  return schemaReadyPromise;
}

export type AnalysisRecord = {
  id: string;
  contractId: string;
  riskBadge: string | null;
  resultJson: JsonObject;
  llmProvider: string | null;
  llmModel: string | null;
  llmPromptTokens: number | null;
  llmCompletionTokens: number | null;
  processingTimeMs: number | null;
  createdAt: string;
};

export type ContractSummaryRecord = {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

/** The jurisdiction the owner confirmed for a contract, which lets analyses include comparisons. */
export type ContractJurisdictionRecord = {
  confirmedJurisdiction: string | null;
  jurisdictionConfirmedAt: string | null;
};

export type ContractRecord = ContractSummaryRecord & ContractJurisdictionRecord & {
  /** Quality warning for the current extracted text, recorded by its upload. */
  extractionWarning: string | null;
  analysesHasMore: boolean;
  analyses: AnalysisRecord[];
};

export type ProjectSummaryRecord = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  contractCount: number;
  contextDocumentCount: number;
};

export type ProjectDetailRecord = {
  contractsHasMore: boolean;
  contextHasMore: boolean;
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  contracts: Array<{
    id: string;
    title: string;
    status: string;
    createdAt: string;
    analyses: Array<{ id: string; riskBadge: string | null }>;
  }>;
  contextDocuments: Array<{
    id: string;
    title: string;
    documentType: string;
    originalFilename: string | null;
    fileSize: number | null;
    wordCount: number | null;
    createdAt: string;
  }>;
};

export type ProjectContextForAnalysisRecord = {
  title: string;
  documentType: string;
  extractionWarning?: string | null;
  extractedText: string;
  originalCharacterCount: number;
};

export type UserSettingsRecord = {
  userId: string;
  primaryModel: PrimaryModel | null;
  personality: PersonalityMode | null;
  updatedAt: string;
};

export type ChatMessageRole = "system" | "user" | "assistant";

export type ChatMessageRecord = {
  files?: ChatFileInfo[];
  agentMessages?: import("ai").ModelMessage[];
  contractEvidence?: ContractEvidence[];
  webSources?: import("@repo/chat-engine/gemini-search").WebSearchSource[];
  toolActivity?: unknown;
  id: string;
  threadId: string;
  role: ChatMessageRole;
  content: string;
  position: number;
  createdAt: string;
  // The model/provider that generated an assistant message, persisted in metadata_json so the
  // "generated by" label survives thread re-hydration and reloads (null for user/older messages).
  model: string | null;
  provider: string | null;
};

export type ChatThreadSummaryRecord = {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type ChatThreadDetailRecord = {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessageRecord[];
  hasMore: boolean;
};

type UploadedContractFileInput = {
  storageIntentId?: string;
  userId: string;
  contractId: string;
  projectId: string | null;
  title: string;
  fileName: string;
  storageKey: string;
  bucket: string;
  contentType: string;
  sizeBytes: number;
  extractionMethod: string | null;
  extractionConfidence: number | null;
};

type NewAnalysisInput = {
  userId: string;
  contractId: string;
  expectedRevision: string;
  riskBadge: string | null;
  resultJson: JsonObject;
  llmProvider: string | null;
  llmModel: string | null;
  llmPromptTokens?: number | null;
  llmCompletionTokens?: number | null;
  processingTimeMs?: number | null;
};

type NewContextDocumentInput = {
  storageIntentId?: string;
  userId: string;
  projectId: string;
  title: string;
  documentType: string;
  storageKey: string;
  bucket: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  extractionWarning?: string | null;
  extractedText: string;
  wordCount: number;
};

function parseJsonObject(value: unknown): JsonObject {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object") {
        return parsed as JsonObject;
      }
      return {};
    } catch {
      return {};
    }
  }

  if (typeof value === "object") {
    return value as JsonObject;
  }

  return {};
}

// Raw analyses row shape (snake_case columns aliased to camelCase). Declared once and shared by
// mapAnalysisRow and the fetch helper instead of repeating the 10-field inline type per query.
type AnalysisRow = {
  id: string;
  contractId: string;
  riskBadge: string | null;
  resultJson: unknown;
  llmProvider: string | null;
  llmModel: string | null;
  llmPromptTokens: number | null;
  llmCompletionTokens: number | null;
  processingTimeMs: number | null;
  createdAt: string;
};

// Fetch history metadata and only the latest result body for the detail page. The analysis endpoint uses
// a single lateral-join snapshot instead, so its contract status and latest result cannot drift.
async function fetchAnalysisRowsByContractId(
  contractId: string,
  offset = 0,
): Promise<AnalysisRow[]> {
  const baseQuery = `
    select
      id,
      contract_id as "contractId",
      risk_badge as "riskBadge",
      case when row_number() over (order by created_at desc, id desc) = 1
        then result_json else null end as "resultJson",
      llm_provider as "llmProvider",
      llm_model as "llmModel",
      llm_prompt_tokens as "llmPromptTokens",
      llm_completion_tokens as "llmCompletionTokens",
      processing_time_ms as "processingTimeMs",
      created_at as "createdAt"
    from analyses
    where contract_id = $1
    order by created_at desc, id desc LIMIT 51 OFFSET $2`;

  const { rows } = await sql.query<AnalysisRow>(baseQuery, [
    contractId,
    clampPagination({ offset }).offset,
  ]);

  return rows;
}

export async function getAnalysisForUser(
  userId: string,
  contractId: string,
  analysisId: string,
): Promise<AnalysisRecord | null> {
  await ensureSchema();
  const { rows } = await sql<AnalysisRow>`
    SELECT a.id, a.contract_id AS "contractId", a.risk_badge AS "riskBadge", a.result_json AS "resultJson",
      a.llm_provider AS "llmProvider", a.llm_model AS "llmModel", a.llm_prompt_tokens AS "llmPromptTokens",
      a.llm_completion_tokens AS "llmCompletionTokens", a.processing_time_ms AS "processingTimeMs", a.created_at AS "createdAt"
    FROM analyses a JOIN contracts c ON c.id = a.contract_id
    WHERE a.id = ${analysisId} AND c.id = ${contractId} AND c.user_id = ${userId}
  `;
  return rows[0] ? mapAnalysisRow(rows[0]) : null;
}

function mapAnalysisRow(row: AnalysisRow): AnalysisRecord {
  const resultJson = parseJsonObject(row.resultJson);

  return {
    id: row.id,
    contractId: row.contractId,
    riskBadge: row.riskBadge,
    resultJson,
    llmProvider: row.llmProvider,
    llmModel: row.llmModel,
    llmPromptTokens: row.llmPromptTokens,
    llmCompletionTokens: row.llmCompletionTokens,
    processingTimeMs: row.processingTimeMs,
    createdAt: row.createdAt,
  };
}

export async function listContractsByUserId(
  userId: string,
  pagination?: PaginationOptions,
  standalone = false,
): Promise<PaginatedResult<ContractSummaryRecord>> {
  await ensureSchema();

  const { limit, offset } = clampPagination(pagination);

  const [{ rows }, { rows: countRows }] = await Promise.all([
    sql<ContractSummaryRecord>`
      select
        id,
        user_id as "userId",
        project_id as "projectId",
        title,
        status,
        created_at as "createdAt",
        updated_at as "updatedAt"
      from contracts
      where user_id = ${userId}
        and (${standalone} = false or project_id is null)
      order by created_at desc, id desc
      limit ${limit} offset ${offset}
    `,
    sql<{ count: number }>`
      select count(*)::integer as count
      from contracts
      where user_id = ${userId}
        and (${standalone} = false or project_id is null)
    `,
  ]);

  return { data: rows, total: countRows[0]?.count ?? 0, limit, offset };
}

export async function createContractForUser(input: {
  userId: string;
  title: string;
  projectId?: string | null;
}): Promise<ContractSummaryRecord> {
  await ensureSchema();

  const validatedProjectId: string | null = input.projectId ?? null;

  if (
    validatedProjectId &&
    !(await isProjectOwnedByUser(input.userId, validatedProjectId))
  ) {
    throw new ProjectNotFoundError();
  }

  // Owner-rooted inserts share-lock the owner's application_users row; see deleteAccountForUser.
  const { rows } = await sql<ContractSummaryRecord>`
    insert into contracts (
      user_id,
      project_id,
      title,
      status
    )
    select id, ${validatedProjectId}::uuid, ${input.title}, 'DRAFT'
    from application_users where id = ${input.userId} for share
    returning
      id,
      user_id as "userId",
      project_id as "projectId",
      title,
      status,
      created_at as "createdAt",
      updated_at as "updatedAt"
  `;

  const created = rows[0];
  if (!created) {
    throw new Error("Failed to create contract");
  }

  return created;
}

export async function getContractByIdForUser(
  userId: string,
  contractId: string,
  analysisOffset = 0,
): Promise<ContractRecord | null> {
  await ensureSchema();

  // The warning belongs to the active text (saved with it by each upload), so the page can show
  // it before any analysis exists. The text itself stays out of this response.
  const { rows: contractRows } = await sql<
    ContractSummaryRecord &
      ContractJurisdictionRecord & { extractionWarning: string | null }
  >`
    select
      id,
      user_id as "userId",
      project_id as "projectId",
      title,
      status,
      extraction_warning as "extractionWarning",
      confirmed_jurisdiction as "confirmedJurisdiction",
      jurisdiction_confirmed_at as "jurisdictionConfirmedAt",
      created_at as "createdAt",
      updated_at as "updatedAt"
    from contracts
    where id = ${contractId}
      and user_id = ${userId}
    limit 1
  `;

  const contract = contractRows[0];
  if (!contract) {
    return null;
  }

  const analysisRows = await fetchAnalysisRowsByContractId(
    contractId,
    analysisOffset,
  );

  const analyses = analysisRows.slice(0, 50).map(mapAnalysisRow);

  return {
    ...contract,
    analyses,
    analysesHasMore: analysisRows.length > 50,
  };
}

// Lightweight read for callers that need only contract metadata (e.g. the upload route reads
// projectId/title). Avoids transferring text_content and scanning/hydrating every analysis row.
export async function getContractMetaForUser(
  userId: string,
  contractId: string,
): Promise<ContractSummaryRecord | null> {
  await ensureSchema();

  const { rows } = await sql<ContractSummaryRecord>`
    select
      id,
      user_id as "userId",
      project_id as "projectId",
      title,
      status,
      created_at as "createdAt",
      updated_at as "updatedAt"
    from contracts
    where id = ${contractId}
      and user_id = ${userId}
    limit 1
  `;

  return rows[0] ?? null;
}

// Identity of the stored text, matching contractSourceRevision. Chat receipts and the source viewer
// use it; updated_at also moves on analysis and project-context changes, so it stays the analysis
// concurrency revision only.
const CONTRACT_CONTENT_REVISION = `'sha256:' || encode(digest(convert_to(coalesce(text_content, ''), 'UTF8'), 'sha256'), 'hex')`;
const CONTRACT_UPDATED_REVISION = `to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

export type ChatContractSummaryRecord = {
  revision: string;
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  updatedAt: string;
  characterCount: number;
  extractionWarning: string | null;
};

// Bounded listing for the chat agent's list_contracts tool: metadata only, newest first.
export async function listContractsForChat(
  userId: string,
  options: { offset?: number; query?: string } = {},
): Promise<{
  contracts: ChatContractSummaryRecord[];
  nextOffset: number | null;
}> {
  await ensureSchema();
  const limit = 50;
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const query = options.query?.trim() ?? "";

  const { rows } = await sql.query<ChatContractSummaryRecord>(
    `select
      id,
      title,
      status,
      ${CONTRACT_CONTENT_REVISION} as revision,
      project_id as "projectId",
      updated_at as "updatedAt",
      coalesce(char_length(text_content), 0)::integer as "characterCount",
      extraction_warning as "extractionWarning"
    from contracts
    where user_id = $1
      and strpos(lower(title), lower($2)) > 0
    order by updated_at desc, id desc
    limit $3
    offset $4`,
    [userId, query, limit + 1, offset],
  );

  return {
    contracts: rows.slice(0, limit),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

export type ChatContractTextRecord = {
  revision: string;
  id: string;
  title: string;
  status: string;
  text: string | null;
  extractionWarning: string | null;
};

// Owner-scoped text read for the chat agent's read_contract tool.
export async function getContractTextForUser(
  userId: string,
  contractId: string,
): Promise<ChatContractTextRecord | null> {
  await ensureSchema();

  const { rows } = await sql.query<ChatContractTextRecord>(
    `select
      id,
      title,
      status,
      ${CONTRACT_CONTENT_REVISION} as revision,
      text_content as "text",
      extraction_warning as "extractionWarning"
    from contracts
    where id = $1
      and user_id = $2
    limit 1`,
    [contractId, userId],
  );

  return rows[0] ?? null;
}

/** Offsets are Unicode code points, matching PostgreSQL substring/char_length. */
export async function getContractWindowForUser(
  userId: string,
  contractId: string,
  offset: number,
) {
  await ensureSchema();
  const start = Math.max(0, Math.min(2_000_000, Math.trunc(offset)));
  const { rows } = await sql.query<
    ChatContractTextRecord & { characterCount: number }
  >(
    `SELECT id, title, status,
      ${CONTRACT_CONTENT_REVISION} AS revision,
      substring(text_content FROM $3::integer FOR 12000) AS text,
      coalesce(char_length(text_content), 0)::integer AS "characterCount",
      extraction_warning AS "extractionWarning"
    FROM contracts WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [contractId, userId, start + 1],
  );
  return rows[0] ?? null;
}

/** One owner-scoped snapshot; a changed revision never returns replacement text. */
export async function getContractSourceForUser(input: {
  userId: string;
  contractId: string;
  offset: number;
  revision: string | null;
  analysisId?: string;
  citation?: SourceCitation;
}): Promise<{
  revision: string;
  text: string | null;
  totalCharacters: number;
  extractionWarning: string | null;
  highlightMatches: boolean;
} | null> {
  await ensureSchema();
  const { rows } = await sql.query<{
    revision: string;
    text: string | null;
    totalCharacters: number;
    extractionWarning: string | null;
    highlightMatches: boolean;
  }>(`
    WITH source AS MATERIALIZED (
      SELECT text_content, extraction_warning,
        ${CONTRACT_CONTENT_REVISION} AS revision,
        coalesce(char_length(text_content), 0)::integer AS total
      FROM contracts c WHERE c.id = $1 AND c.user_id = $2
        AND ($8::uuid IS NULL OR EXISTS (
          SELECT 1 FROM analyses a WHERE a.id = $8 AND a.contract_id = c.id
        ))
    )
    SELECT revision, total AS "totalCharacters", extraction_warning AS "extractionWarning",
      CASE WHEN $3::text IS NULL OR revision = $3
        THEN coalesce(substring(text_content FROM $4::integer + 1 FOR ${SOURCE_PAGE_SIZE}), '')
        ELSE NULL END AS text,
      coalesce(revision = $3 AND $5::integer >= 0 AND $6::integer > $5
        AND $6 <= total AND $6 - $5 <= ${MAX_EVIDENCE_QUOTE}
        AND (total <= ${CONTRACT_ANALYSIS_LIMIT} OR $6 <= ${CONTRACT_HEAD_LENGTH} OR $5 >= total - ${CONTRACT_TAIL_LENGTH})
        AND substring(text_content FROM $5::integer + 1 FOR $6::integer - $5::integer) = $7,
        false) AS "highlightMatches"
    FROM source`, [
    input.contractId, input.userId, input.revision, input.offset,
    input.citation?.start ?? null, input.citation?.end ?? null,
    input.citation?.quote ?? null, input.analysisId ?? null,
  ]);
  return rows[0] ?? null;
}

export type ContractAnalysisGate = {
  status: string;
  hasText: boolean;
  latestAnalysisId: string | null;
};

export type ContractWithLatestAnalysisRecord = ContractSummaryRecord & {
  text: string | null;
  extractionWarning: string | null;
  /** Passed to the analysis as its region; null keeps regional comparisons withheld. */
  confirmedJurisdiction: string | null;
  revision: string;
  latestAnalysis: { id: string } | null;
};

// Idempotency probe for POST /analyze. Status, a non-empty-text flag, and the latest analysis id
// are enough to return "already exists". The contract body and result_json stay in the database.
export async function getContractAnalysisGateForUser(
  userId: string,
  contractId: string,
): Promise<ContractAnalysisGate | null> {
  await ensureSchema();

  const { rows } = await sql<ContractAnalysisGate>`
    select
      c.status,
      (c.text_content ~ '[^[:space:]]') is true as "hasText",
      latest.id as "latestAnalysisId"
    from contracts c
    left join lateral (
      select a.id
      from analyses a
      where a.contract_id = c.id
      order by a.created_at desc, a.id desc
      limit 1
    ) latest on true
    where c.id = ${contractId}
      and c.user_id = ${userId}
    limit 1
  `;

  return rows[0] ?? null;
}

// Text plus revision for a run that is about to call the model. The latest analysis id is only
// the race re-check (a result may have landed after the gate); its JSON is not loaded.
export async function getContractWithLatestAnalysisForUser(
  userId: string,
  contractId: string,
): Promise<ContractWithLatestAnalysisRecord | null> {
  await ensureSchema();

  const { rows } = await sql<
    ContractSummaryRecord & {
      text: string | null;
      extractionWarning: string | null;
      confirmedJurisdiction: string | null;
      revision: string;
      analysisId: string | null;
    }
  >`
    select
      c.id,
      c.user_id as "userId",
      c.project_id as "projectId",
      c.title,
      c.status,
      c.text_content as "text",
      c.extraction_warning as "extractionWarning",
      c.confirmed_jurisdiction as "confirmedJurisdiction",
      to_char(
        c.updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US'
      ) as "revision",
      c.created_at as "createdAt",
      c.updated_at as "updatedAt",
      latest.id as "analysisId"
    from contracts c
    left join lateral (
      select a.id
      from analyses a
      where a.contract_id = c.id
      order by a.created_at desc, a.id desc
      limit 1
    ) latest on true
    where c.id = ${contractId}
      and c.user_id = ${userId}
    limit 1
  `;

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.userId,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    text: row.text,
    extractionWarning: row.extractionWarning,
    confirmedJurisdiction: row.confirmedJurisdiction,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestAnalysis: row.analysisId ? { id: row.analysisId } : null,
  };
}

/**
 * Confirm, change, or clear (null) the owner's jurisdiction for a contract; null when the contract
 * is not theirs. It describes the contract rather than its text, so the analysis revision
 * (updated_at) is left alone; each analysis records the jurisdiction it ran with instead.
 */
export async function setContractJurisdictionForUser(input: {
  userId: string;
  contractId: string;
  jurisdiction: string | null;
}): Promise<ContractJurisdictionRecord | null> {
  await ensureSchema();

  const { rows } = await sql<ContractJurisdictionRecord>`
    update contracts
    set confirmed_jurisdiction = ${input.jurisdiction}::text,
      jurisdiction_confirmed_at = case
        when ${input.jurisdiction}::text is null then null else now() end
    where id = ${input.contractId}
      and user_id = ${input.userId}
    returning
      confirmed_jurisdiction as "confirmedJurisdiction",
      jurisdiction_confirmed_at as "jurisdictionConfirmedAt"
  `;

  return rows[0] ?? null;
}

export async function saveContractUploadForUser(
  input: UploadedContractFileInput & {
    text: string;
    extractionWarning?: string | null;
  },
): Promise<boolean> {
  await ensureSchema();

  // Commit extracted text, file metadata, and cancellation of the cleanup intent atomically.
  // An uncertain commit result must never trigger immediate deletion of the uploaded object.
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `UPDATE contracts
       SET text_content = $1, status = 'DRAFT', updated_at = clock_timestamp(), extraction_warning = $4
       WHERE id = $2 AND user_id = $3`,
      [
        input.text,
        input.contractId,
        input.userId,
        input.extractionWarning ?? null,
      ],
    );

    if (!rowCount) {
      await client.query("ROLLBACK");
      return false;
    }

    // storage_key is canonical; blob_path remains null for new rows while legacy reads coalesce.
    await client.query(
      `INSERT INTO contract_files (
         user_id, project_id, contract_id, title, file_name, storage_key, bucket,
         content_type, size_bytes, extraction_method, extraction_confidence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.userId,
        input.projectId,
        input.contractId,
        input.title,
        input.fileName,
        input.storageKey,
        input.bucket,
        input.contentType,
        input.sizeBytes,
        input.extractionMethod,
        input.extractionConfidence,
      ],
    );

    await consumeUploadIntent(client, input.storageIntentId);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function createAnalysisForContract(
  input: NewAnalysisInput,
): Promise<{ id: string }> {
  await ensureSchema();

  // Insert the analysis and flip the contract to ANALYZED atomically in one transaction (on a
  // single checked-out connection) so a crash can't leave an analysis row without the status flip.
  const client = await sql.connect();
  try {
    await client.query("BEGIN");

    // Lock and compare the exact revision that was sent to the model. A re-upload or another
    // completed analysis changes updated_at, so stale/concurrent work cannot mark a newer revision
    // ANALYZED or insert a duplicate result for the same starting snapshot.
    const { rowCount: lockedRevisionCount } = await client.query(
      `SELECT id
       FROM contracts
       WHERE id = $1
         AND user_id = $2
         AND to_char(
           updated_at at time zone 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US'
         ) = $3
       FOR UPDATE`,
      [input.contractId, input.userId, input.expectedRevision],
    );

    if (!lockedRevisionCount) {
      throw new ContractRevisionChangedError();
    }

    const { rows: analysisRows } = await client.query<{ id: string }>(
      `INSERT INTO analyses (
         contract_id, risk_badge, result_json,
         llm_provider, llm_model, llm_prompt_tokens, llm_completion_tokens, processing_time_ms
       )
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.contractId,
        input.riskBadge,
        JSON.stringify(input.resultJson),
        input.llmProvider,
        input.llmModel,
        input.llmPromptTokens ?? null,
        input.llmCompletionTokens ?? null,
        input.processingTimeMs ?? null,
      ],
    );

    const created = analysisRows[0];
    if (!created) {
      throw new Error("Contract not found");
    }

    await client.query(
      `UPDATE contracts SET status = 'ANALYZED', updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [input.contractId, input.userId],
    );

    await client.query("COMMIT");
    return created;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteAnalysisForContract(input: {
  userId: string;
  contractId: string;
  analysisId?: string;
  keepAnalysisId?: string;
}): Promise<boolean> {
  await ensureSchema();
  if (!input.analysisId && !input.keepAnalysisId)
    throw new Error("An analysis ID is required");

  // Delete the analysis and, if it was the contract's last one, revert the contract status — in a
  // single transaction so the contract can't be left badged ANALYZED with zero analyses.
  const client = await sql.connect();
  try {
    await client.query("BEGIN");

    const locked = await client.query(
      "SELECT id FROM contracts WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [input.contractId, input.userId],
    );
    if (!locked.rowCount) {
      await client.query("ROLLBACK");
      return false;
    }

    const latest = await client.query<{ id: string }>(
      "SELECT id FROM analyses WHERE contract_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [input.contractId],
    );
    const deletingLatest = Boolean(
      input.analysisId && latest.rows[0]?.id === canonicalUuid(input.analysisId),
    );

    const { rows } = await client.query<{ id: string }>(
      `DELETE FROM analyses
       USING contracts
       WHERE (($1::uuid IS NOT NULL AND analyses.id = $1)
           OR ($4::uuid IS NOT NULL AND (analyses.created_at, analyses.id) <
             (SELECT created_at, id FROM analyses WHERE id = $4 AND contract_id = $2)))
         AND analyses.contract_id = $2
         AND contracts.id = analyses.contract_id
         AND contracts.user_id = $3
       RETURNING analyses.id`,
      [
        input.analysisId ?? null,
        input.contractId,
        input.userId,
        input.keepAnalysisId ?? null,
      ],
    );

    if (!rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }

    // Removing the current result cannot promote an older evidence snapshot to current.
    await client.query(
      `UPDATE contracts
       SET status = 'DRAFT', updated_at = now()
       WHERE id = $1 AND user_id = $2
         AND ($3 OR NOT EXISTS (SELECT 1 FROM analyses WHERE contract_id = $1))`,
      [input.contractId, input.userId, deletingLatest],
    );

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Saved turns that read a contract the owner no longer has would replay its excerpts to the model.
// Dropping the turn's agent state leaves the visible reply in place.
const SCRUB_UNOWNED_CONTRACT_REPLAY = `
  UPDATE chat_messages m SET metadata_json = (m.metadata_json - 'agentMessages' - 'webSources') || '{"contractEvidenceInvalid":true}'::jsonb
  FROM chat_threads t
  WHERE t.id = m.thread_id AND t.user_id = $1
    AND EXISTS (
      SELECT 1
      FROM (
        SELECT v FROM jsonb_path_query(m.metadata_json, '$.agentMessages[*].content[*].input.contractId') AS old(v)
        UNION ALL
        SELECT v FROM jsonb_path_query(m.metadata_json, '$.contractEvidence[*].id') AS receipt(v)
      ) AS ref(v)
      WHERE NOT EXISTS (
        SELECT 1 FROM contracts c
        WHERE c.user_id = $1 AND c.id::text = lower(btrim(ref.v #>> '{}'))
      )
    )`;

async function deleteOwnedAndScrubChatReplay(
  deleteStatement: string,
  id: string,
  userId: string,
): Promise<{ deleted: boolean }> {
  await ensureSchema();
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(deleteStatement, [id, userId]);
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return { deleted: false };
    }
    await client.query(SCRUB_UNOWNED_CONTRACT_REPLAY, [userId]);
    await client.query("COMMIT");
    return { deleted: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteContractForUser(input: {
  userId: string;
  contractId: string;
}): Promise<{ deleted: boolean }> {
  return deleteOwnedAndScrubChatReplay(
    "DELETE FROM contracts WHERE id = $1 AND user_id = $2",
    input.contractId,
    input.userId,
  );
}

export async function createProjectForUser(input: {
  userId: string;
  title: string;
  description?: string | null;
}): Promise<ProjectSummaryRecord> {
  await ensureSchema();

  const { rows } = await sql<ProjectSummaryRecord>`
    insert into projects (
      user_id,
      title,
      description,
      status
    )
    select id, ${input.title}, ${input.description ?? null}::text, 'active'
    from application_users where id = ${input.userId} for share
    returning
      id,
      user_id as "userId",
      title,
      description,
      status,
      created_at as "createdAt",
      updated_at as "updatedAt",
      0::integer as "contractCount",
      0::integer as "contextDocumentCount"
  `;

  const created = rows[0];
  if (!created) {
    throw new Error("Failed to create project");
  }

  return created;
}

export async function listProjectsByUserId(
  userId: string,
  pagination?: PaginationOptions,
): Promise<PaginatedResult<ProjectSummaryRecord>> {
  await ensureSchema();

  const { limit, offset } = clampPagination(pagination);

  const [{ rows: projectRows }, { rows: countRows }] = await Promise.all([
    sql<ProjectSummaryRecord>`
      select
        p.id,
        p.user_id as "userId",
        p.title,
        p.description,
        p.status,
        p.created_at as "createdAt",
        p.updated_at as "updatedAt",
        (
          select count(*)::integer
          from contracts c
          where c.project_id = p.id
            and c.user_id = ${userId}
        ) as "contractCount",
        (
          select count(*)::integer
          from context_documents cd
          where cd.project_id = p.id
        ) as "contextDocumentCount"
      from projects p
      where p.user_id = ${userId}
      order by p.created_at desc, p.id desc
      limit ${limit} offset ${offset}
    `,
    sql<{ count: number }>`
      select count(*)::integer as count
      from projects
      where user_id = ${userId}
    `,
  ]);

  return {
    data: projectRows,
    total: countRows[0]?.count ?? 0,
    limit,
    offset,
  };
}

// Cheapest possible ownership probe: one indexed lookup, no child rows. Prefer this over
// getProjectByIdForUser wherever only the boolean matters — that function fans out into four
// unbounded queries (project, all contracts, all context documents, latest analyses).
export async function isProjectOwnedByUser(
  userId: string,
  projectId: string,
): Promise<boolean> {
  await ensureSchema();

  const { rows } = await sql<{ id: string }>`
    select id
    from projects
    where id = ${projectId}
      and user_id = ${userId}
    limit 1
  `;

  return !!rows[0];
}

export async function getProjectByIdForUser(
  userId: string,
  projectId: string,
  options: { contractsOffset?: number; contextOffset?: number } = {},
): Promise<ProjectDetailRecord | null> {
  await ensureSchema();

  const { rows: projectRows } = await sql<{
    id: string;
    userId: string;
    title: string;
    description: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>`
    select
      id,
      user_id as "userId",
      title,
      description,
      status,
      created_at as "createdAt",
      updated_at as "updatedAt"
    from projects
    where id = ${projectId}
      and user_id = ${userId}
    limit 1
  `;

  const project = projectRows[0];
  if (!project) {
    return null;
  }

  const [{ rows: contractRows }, { rows: contextDocuments }] =
    await Promise.all([
      sql<{
        id: string;
        title: string;
        status: string;
        createdAt: string;
      }>`
      select
        id,
        title,
        status,
        created_at as "createdAt"
      from contracts
      where project_id = ${projectId}
        and user_id = ${userId}
      order by created_at desc, id desc
      LIMIT 51 OFFSET ${clampPagination({ offset: options.contractsOffset }).offset}
    `,
      listProjectContextDocumentsForUser(
        userId,
        projectId,
        options.contextOffset,
        51,
      ).then((rows) => ({ rows })),
    ]);

  const analysesByContract = new Map<
    string,
    Array<{ id: string; riskBadge: string | null }>
  >();

  if (contractRows.length > 0) {
    const contractIds = contractRows.slice(0, 50).map((c) => c.id);

    const { rows: analysisRows } = await sql.query<{
      contractId: string;
      id: string;
      riskBadge: string | null;
    }>(
      // One indexed lookup per displayed contract, independent of its full analysis history.
      `select selected.contract_id as "contractId", latest.id, latest.risk_badge as "riskBadge"
      from unnest($1::uuid[]) as selected(contract_id)
      cross join lateral (
        select a.id, a.risk_badge
        from analyses a
        where a.contract_id = selected.contract_id
        order by a.created_at desc, a.id desc
        limit 1
      ) latest`,
      [contractIds],
    );

    for (const row of analysisRows) {
      const list = analysesByContract.get(row.contractId) ?? [];
      list.push({ id: row.id, riskBadge: row.riskBadge });
      analysesByContract.set(row.contractId, list);
    }
  }

  const contracts = contractRows.slice(0, 50).map((contract) => ({
    ...contract,
    analyses: analysesByContract.get(contract.id) ?? [],
  }));

  return {
    ...project,
    contracts,
    contractsHasMore: contractRows.length > 50,
    contextHasMore: contextDocuments.length > 50,
    contextDocuments: contextDocuments.slice(0, 50),
  };
}

/**
 * Fetch only the small, ownership-scoped context excerpt needed by contract analysis. Keeping the
 * bound in SQL prevents a large context upload from being transferred wholesale just to be sliced
 * for the model prompt. Both the beginning and end are retained for definitions and late clauses.
 */
export async function listProjectContextDocumentsForUser(
  userId: string,
  projectId: string,
  offset = 0,
  limit = 50,
): Promise<ProjectDetailRecord["contextDocuments"]> {
  await ensureSchema();
  return (
    await sql<ProjectDetailRecord["contextDocuments"][number]>`
    SELECT cd.id, cd.title, cd.document_type AS "documentType", cd.original_filename AS "originalFilename",
      cd.size_bytes AS "fileSize", cd.word_count AS "wordCount", cd.created_at AS "createdAt"
    FROM context_documents cd JOIN projects p ON p.id = cd.project_id
    WHERE p.id = ${projectId} AND p.user_id = ${userId} ORDER BY cd.created_at DESC, cd.id DESC
    LIMIT ${Math.min(51, Math.max(1, limit))} OFFSET ${clampPagination({ offset }).offset}
  `
  ).rows;
}

export async function getProjectContextForAnalysis(
  userId: string,
  projectId: string,
): Promise<ProjectContextForAnalysisRecord[]> {
  await ensureSchema();

  // Match the analysis prompt's per-document budget (MAX_CONTEXT_DOCUMENT_PROMPT_CHARS in
  // lib/analysis.ts) exactly. Selecting more only moved bytes that buildBoundedExcerpt trimmed
  // again on arrival — and that second trim stacked a second "omitted from the middle" marker
  // describing the same gap. The marker is counted against the budget here so the returned value
  // lands on the limit rather than just over it, which would re-trigger the trim it replaces.
  const omissionMarker = "\n\n[Context excerpt omitted from the middle]\n\n";
  const maxDocumentCharacters = 3_000;
  const headCharacters = Math.ceil(
    (maxDocumentCharacters - omissionMarker.length) * 0.65,
  );
  const tailCharacters =
    maxDocumentCharacters - omissionMarker.length - headCharacters;
  // Prioritize recently added evidence. Fetch one sentinel beyond the prompt's eight-document cap
  // so the prompt can disclose omissions without transferring the whole project collection.
  const maxDocuments = 9;

  const { rows } = await sql<ProjectContextForAnalysisRecord>`
    select
      cd.title,
      cd.extraction_warning as "extractionWarning",
      cd.document_type as "documentType",
      case
        when char_length(cd.extracted_text) > ${maxDocumentCharacters}
          then left(cd.extracted_text, ${headCharacters})
            || ${omissionMarker}
            || right(cd.extracted_text, ${tailCharacters})
        else cd.extracted_text
      end as "extractedText",
      char_length(cd.extracted_text)::integer as "originalCharacterCount"
    from context_documents cd
    inner join projects p on p.id = cd.project_id
    where cd.project_id = ${projectId}
      and p.user_id = ${userId}
      and nullif(btrim(cd.extracted_text), '') is not null
    order by cd.created_at desc, cd.id desc
    limit ${maxDocuments}
  `;

  return rows;
}

export async function addContextDocumentToProject(
  input: NewContextDocumentInput,
): Promise<{ id: string }> {
  await ensureSchema();

  // Insert only if the project is owned by the user — folds the ownership check into the write so
  // there's no separate round-trip. No inserted row ⇒ the project doesn't exist / isn't owned.
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `insert into context_documents (
       project_id, title, document_type, storage_key, bucket,
       original_filename, content_type, size_bytes, extracted_text, word_count, extraction_warning
     )
     select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $12
     where exists (select 1 from projects where id = $1 and user_id = $11)
     returning id`,
      [
        input.projectId,
        input.title,
        input.documentType,
        input.storageKey,
        input.bucket,
        input.originalFilename,
        input.contentType,
        input.sizeBytes,
        input.extractedText,
        input.wordCount,
        input.userId,
        input.extractionWarning ?? null,
      ],
    );

    const created = rows[0];
    if (!created) {
      throw new ProjectNotFoundError();
    }

    await consumeUploadIntent(client, input.storageIntentId);
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function consumeUploadIntent(client: VercelPoolClient, id?: string) {
  if (!id) return;
  const result = await client.query(
    "DELETE FROM storage_deletions WHERE id = $1 AND lease_token IS NULL AND attempts = 0 RETURNING id",
    [id],
  );
  if (!result.rowCount)
    throw new Error("Upload cleanup has already started. Please upload again.");
}

export async function deleteContextDocumentFromProject(input: {
  userId: string;
  projectId: string;
  documentId: string;
}): Promise<{ deleted: boolean }> {
  await ensureSchema();

  // Join projects so ownership is enforced in the DELETE itself (no separate pre-check round-trip).
  const { rows } = await sql<{ id: string }>`
    delete from context_documents cd
    using projects p
    where cd.id = ${input.documentId}
      and cd.project_id = ${input.projectId}
      and p.id = cd.project_id
      and p.user_id = ${input.userId}
    returning cd.id
  `;

  if (!rows[0]) {
    return { deleted: false };
  }

  return { deleted: true };
}

export async function deleteProjectForUser(input: {
  userId: string;
  projectId: string;
}): Promise<{ deleted: boolean }> {
  return deleteOwnedAndScrubChatReplay(
    "DELETE FROM projects WHERE id = $1 AND user_id = $2",
    input.projectId,
    input.userId,
  );
}

// Children go before their parents and are scoped through an owned parent, so legacy rows behind
// foreign keys that migration 012 could not validate are removed too. Deleting contract files and
// context documents queues their stored objects in the storage_deletions outbox (012's triggers).
const DELETE_ACCOUNT_STATEMENTS = [
  "DELETE FROM chat_messages m USING chat_threads t WHERE t.id = m.thread_id AND t.user_id = $1",
  // Cascades to chat_attachments and chat_files.
  "DELETE FROM chat_threads WHERE user_id = $1",
  "DELETE FROM analyses a USING contracts c WHERE c.id = a.contract_id AND c.user_id = $1",
  "DELETE FROM contract_files WHERE user_id = $1 OR contract_id IN (SELECT id FROM contracts WHERE user_id = $1)",
  "DELETE FROM contracts WHERE user_id = $1",
  "DELETE FROM context_documents d USING projects p WHERE p.id = d.project_id AND p.user_id = $1",
  "DELETE FROM projects WHERE user_id = $1",
  "DELETE FROM user_settings WHERE user_id = $1",
  // Lease keys are `<kind>:<owner>:<uuid>`; strip the 37-character `:<uuid>` to compare exactly.
  `DELETE FROM generation_operations
   WHERE left(entity_key, length(entity_key) - 37) IN ('contract:' || $1, 'chat:' || $1)`,
];

/**
 * Delete everything an owner has in one transaction. Stored objects are queued in the outbox and
 * removed by storage cleanup, never inline. Repeating the call deletes whatever is left. Saved chat
 * replay needs no scrubbing, because the threads go with the contracts they cite.
 *
 * Every owner-rooted insert (contracts, projects, settings, chat threads) share-locks the owner's
 * application_users row, and every other owned row hangs off one of those. Locking that row first
 * waits for writes already under way, so the deletes below see them, and blocks new ones until
 * commit. Once the row is gone they insert nothing, so a request authenticated before the deletion
 * cannot recreate data afterwards. `keepLogin` keeps the row and the WorkOS mapping, so that a
 * retry after a failed WorkOS deletion resolves the session to the same owner and sweeps any late
 * writes; the final call removes them.
 */
export async function deleteAccountForUser(
  userId: string,
  options: { keepLogin?: boolean } = {},
): Promise<void> {
  await ensureSchema();
  const { principal } = admissionLimits(userId);
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM application_users WHERE id = $1 FOR UPDATE", [userId]);
    for (const statement of DELETE_ACCOUNT_STATEMENTS) {
      await client.query(statement, [userId]);
    }
    // Admission rows are keyed by the one-way hash of the owner ID.
    await client.query("DELETE FROM chat_admissions WHERE principal = $1", [principal]);
    await client.query("DELETE FROM chat_request_budgets WHERE bucket = $1", [principal]);
    if (!options.keepLogin) {
      await client.query("DELETE FROM auth_identities WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM application_users WHERE id = $1", [userId]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type AccountExportContractFile = {
  id: string;
  contractId: string | null;
  fileName: string;
  contentType: string | null;
  sizeBytes: number | null;
  extractionMethod: string | null;
  extractionConfidence: number | null;
  createdAt: string;
  /** Internal object location, for reading the bytes; never part of the archive. */
  storageKey: string | null;
};

export type AccountExportContextDocument = {
  id: string;
  projectId: string;
  title: string;
  documentType: string;
  originalFilename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  wordCount: number | null;
  extractedText: string | null;
  extractionWarning: string | null;
  createdAt: string;
  updatedAt: string;
  /** Internal object location, for reading the bytes; never part of the archive. */
  storageKey: string | null;
};

export type AccountExportData = {
  contracts: Array<{
    id: string;
    projectId: string | null;
    title: string;
    status: string;
    textContent: string | null;
    extractionWarning: string | null;
    confirmedJurisdiction: string | null;
    jurisdictionConfirmedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  contractFiles: AccountExportContractFile[];
  analyses: AnalysisRecord[];
  projects: Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
  contextDocuments: AccountExportContextDocument[];
  chatThreads: Array<{ id: string; title: string; createdAt: string; updatedAt: string }>;
  chatMessages: Array<Omit<ChatMessageRecord, "agentMessages" | "contractEvidence">>;
  chatFiles: Array<{
    id: string;
    threadId: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    warning: string | null;
    createdAt: string;
  }>;
  chatImages: Array<{ id: string; threadId: string; sizeBytes: number; createdAt: string }>;
  settings: Omit<UserSettingsRecord, "userId"> | null;
};

// Every query is scoped to the owner, directly or through an owned parent, with the same reach as
// DELETE_ACCOUNT_STATEMENTS. Operational rows (leases, admissions, budgets, the storage outbox and
// the login mapping) are never read. Chat file and image bytes stay in the database; the archive
// loads them one at a time with getChatFileForUser and getChatImageForUser.
const ACCOUNT_EXPORT_QUERIES = {
  contracts: `SELECT id, project_id AS "projectId", title, status, text_content AS "textContent",
      extraction_warning AS "extractionWarning", confirmed_jurisdiction AS "confirmedJurisdiction",
      jurisdiction_confirmed_at AS "jurisdictionConfirmedAt", created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM contracts WHERE user_id = $1 ORDER BY created_at, id`,
  contractFiles: `SELECT id, contract_id AS "contractId", file_name AS "fileName",
      content_type AS "contentType", size_bytes AS "sizeBytes", extraction_method AS "extractionMethod",
      extraction_confidence AS "extractionConfidence", created_at AS "createdAt",
      coalesce(storage_key, blob_path) AS "storageKey"
    FROM contract_files
    WHERE user_id = $1 OR contract_id IN (SELECT id FROM contracts WHERE user_id = $1)
    ORDER BY created_at, id`,
  analyses: `SELECT a.id, a.contract_id AS "contractId", a.risk_badge AS "riskBadge",
      a.result_json AS "resultJson", a.llm_provider AS "llmProvider", a.llm_model AS "llmModel",
      a.llm_prompt_tokens AS "llmPromptTokens", a.llm_completion_tokens AS "llmCompletionTokens",
      a.processing_time_ms AS "processingTimeMs", a.created_at AS "createdAt"
    FROM analyses a JOIN contracts c ON c.id = a.contract_id
    WHERE c.user_id = $1 ORDER BY a.created_at, a.id`,
  projects: `SELECT id, title, description, status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM projects WHERE user_id = $1 ORDER BY created_at, id`,
  contextDocuments: `SELECT d.id, d.project_id AS "projectId", d.title, d.document_type AS "documentType",
      d.original_filename AS "originalFilename", d.content_type AS "contentType",
      d.size_bytes AS "sizeBytes", d.word_count AS "wordCount", d.extracted_text AS "extractedText",
      d.extraction_warning AS "extractionWarning", d.created_at AS "createdAt",
      d.updated_at AS "updatedAt", d.storage_key AS "storageKey"
    FROM context_documents d JOIN projects p ON p.id = d.project_id
    WHERE p.user_id = $1 ORDER BY d.created_at, d.id`,
  chatThreads: `SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM chat_threads WHERE user_id = $1 ORDER BY created_at, id`,
  // The model's private tool transcript (agentMessages) is replay state, not conversation.
  chatMessages: `SELECT m.id, m.thread_id AS "threadId", m.role, m.content, m.position,
      m.created_at AS "createdAt", m.metadata_json - 'agentMessages' AS metadata
    FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
    WHERE t.user_id = $1 ORDER BY m.thread_id, m.position, m.created_at`,
  chatFiles: `SELECT f.id, f.thread_id AS "threadId", f.filename, f.media_type AS "mediaType",
      octet_length(f.file_data) AS "sizeBytes", f.warning, f.created_at AS "createdAt"
    FROM chat_files f JOIN chat_threads t ON t.id = f.thread_id
    WHERE t.user_id = $1 ORDER BY f.created_at, f.id`,
  chatImages: `SELECT a.id, a.thread_id AS "threadId", octet_length(a.image_data) AS "sizeBytes",
      a.created_at AS "createdAt"
    FROM chat_attachments a JOIN chat_threads t ON t.id = a.thread_id
    WHERE t.user_id = $1 ORDER BY a.created_at, a.id`,
  settings: `SELECT primary_model AS "primaryModel", personality, updated_at AS "updatedAt"
    FROM user_settings WHERE user_id = $1`,
} as const;

/**
 * Read everything an owner keeps in SignLoop for a data export, from one consistent snapshot.
 * File bytes are not loaded here: stored objects are read by key and chat files and images by ID
 * while the archive streams.
 */
export async function getAccountExportForUser(userId: string): Promise<AccountExportData> {
  await ensureSchema();
  const client = await sql.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const read = async <T extends Record<string, unknown>>(query: string) =>
      (await client.query<T>(query, [userId])).rows;
    const data: AccountExportData = {
      contracts: await read(ACCOUNT_EXPORT_QUERIES.contracts),
      contractFiles: await read(ACCOUNT_EXPORT_QUERIES.contractFiles),
      analyses: (await read<AnalysisRow>(ACCOUNT_EXPORT_QUERIES.analyses)).map(mapAnalysisRow),
      projects: await read(ACCOUNT_EXPORT_QUERIES.projects),
      contextDocuments: await read(ACCOUNT_EXPORT_QUERIES.contextDocuments),
      chatThreads: await read(ACCOUNT_EXPORT_QUERIES.chatThreads),
      chatMessages: (
        await read<{
          id: string;
          threadId: string;
          role: string;
          content: string;
          position: number;
          createdAt: string;
          metadata: unknown;
        }>(ACCOUNT_EXPORT_QUERIES.chatMessages)
      ).map((row) => {
        const metadata = parseJsonObject(row.metadata);
        const webSources = parseWebSources(metadata.webSources);
        return {
          ...mapChatMessageRow(row, "omit"),
          ...(webSources?.length ? { webSources } : {}),
        };
      }),
      chatFiles: await read(ACCOUNT_EXPORT_QUERIES.chatFiles),
      chatImages: await read(ACCOUNT_EXPORT_QUERIES.chatImages),
      settings: (await read<Omit<UserSettingsRecord, "userId">>(ACCOUNT_EXPORT_QUERIES.settings))[0] ?? null,
    };
    await client.query("COMMIT");
    return data;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getUserSettingsByUserId(
  userId: string,
): Promise<UserSettingsRecord | null> {
  await ensureSchema();

  const { rows } = await sql<UserSettingsRecord>`
    select
      user_id as "userId",
      primary_model as "primaryModel",
      personality as "personality",
      updated_at as "updatedAt"
    from user_settings
    where user_id = ${userId}
    limit 1
  `;

  return rows[0] ?? null;
}

export async function upsertUserSettings(input: {
  userId: string;
  primaryModel?: PrimaryModel;
  personality?: PersonalityMode;
}): Promise<UserSettingsRecord> {
  await ensureSchema();
  const { rows } = await sql<UserSettingsRecord>`
    INSERT INTO user_settings(user_id, primary_model, personality, updated_at)
    SELECT id, ${input.primaryModel ?? null}::text, ${input.personality ?? null}::text, now()
    FROM application_users WHERE id = ${input.userId} FOR SHARE
    ON CONFLICT (user_id) DO UPDATE SET
      primary_model = CASE WHEN ${input.primaryModel !== undefined} THEN excluded.primary_model ELSE user_settings.primary_model END,
      personality = CASE WHEN ${input.personality !== undefined} THEN excluded.personality ELSE user_settings.personality END,
      updated_at = now()
    RETURNING user_id AS "userId", primary_model AS "primaryModel", personality, updated_at AS "updatedAt"
  `;
  if (!rows[0]) throw new Error("Failed to save user settings");
  return rows[0];
}

/** Normalize stored metadata, omitting private replay and stale evidence when requested. */
function mapChatMessageRow(
  row: {
    id: string;
    threadId: string;
    role: string;
    content: string;
    position: number;
    createdAt: string;
    metadata?: unknown;
  },
  replayState: "include" | "omit" = "include",
): ChatMessageRecord {
  const role: ChatMessageRole =
    row.role === "system" || row.role === "assistant" ? row.role : "user";

  const metadata = parseJsonObject(row.metadata);
  const model =
    typeof metadata.model === "string" && metadata.model.trim()
      ? metadata.model
      : null;
  const provider =
    typeof metadata.provider === "string" && metadata.provider.trim()
      ? metadata.provider
      : null;

  return {
    id: row.id,
    threadId: row.threadId,
    role,
    content: replayState === "include" && metadata.contractEvidenceInvalid === true ? STALE_CONTRACT_REPLY : row.content,
    position: row.position,
    createdAt: row.createdAt,
    ...(replayState === "include"
      ? {
          agentMessages: parseAgentMessages(metadata.agentMessages),
          contractEvidence: metadata.contractEvidenceInvalid === true ? undefined : parseContractEvidence(metadata.contractEvidence) ?? undefined,
          webSources: parseWebSources(metadata.webSources),
        }
      : {}),
    toolActivity: metadata.toolActivity,
    model,
    provider,
    ...(Array.isArray(metadata.files) && !(replayState === "include" && metadata.contractEvidenceInvalid === true)
      ? { files: parseChatFileInfos(metadata.files) } : {}),
  };
}

export async function createChatThreadForUser(input: {
  userId: string;
  title?: string | null;
}): Promise<ChatThreadSummaryRecord> {
  await ensureSchema();

  const title = input.title?.trim() || "New chat";

  const { rows } = await sql<ChatThreadSummaryRecord>`
    insert into chat_threads (
      user_id,
      title
    )
    select id, ${title} from application_users where id = ${input.userId} for share
    returning
      id,
      user_id as "userId",
      title,
      created_at as "createdAt",
      updated_at as "updatedAt",
      0::integer as "messageCount"
  `;

  const created = rows[0];
  if (!created) {
    throw new Error("Failed to create chat thread");
  }

  return created;
}

export async function listChatThreadsByUserId(
  userId: string,
  pagination?: PaginationOptions,
): Promise<PaginatedResult<ChatThreadSummaryRecord>> {
  await ensureSchema();

  const { limit, offset } = clampPagination(pagination);

  const [{ rows }, { rows: countRows }] = await Promise.all([
    sql<ChatThreadSummaryRecord>`
      select
        t.id,
        t.user_id as "userId",
        t.title,
        t.created_at as "createdAt",
        t.updated_at as "updatedAt",
        (
          select count(*)::integer
          from chat_messages m
          where m.thread_id = t.id
        ) as "messageCount"
      from chat_threads t
      where t.user_id = ${userId}
      order by t.updated_at desc
      limit ${limit} offset ${offset}
    `,
    sql<{ count: number }>`
      select count(*)::integer as count
      from chat_threads
      where user_id = ${userId}
    `,
  ]);

  return { data: rows, total: countRows[0]?.count ?? 0, limit, offset };
}

async function currentContractRevisions(
  userId: string,
  metadata: Record<string, unknown>[],
  client?: VercelPoolClient,
): Promise<Map<string, CurrentContractRevision>> {
  const ids = [...new Set(metadata.flatMap((item) =>
    (parseContractEvidence(item.contractEvidence) ?? []).map((ref) => ref.id),
  ))].sort();
  if (!ids.length) return new Map();
  // Both values come from one row version, so a matching legacy timestamp vouches for the hash.
  const { rows } = await (client ?? sql).query<{ id: string } & CurrentContractRevision>(
    `SELECT id, ${CONTRACT_CONTENT_REVISION} AS content, ${CONTRACT_UPDATED_REVISION} AS "updatedAt"
     FROM contracts WHERE user_id = $1 AND id = ANY($2::uuid[])
     ORDER BY id ${client ? "FOR SHARE" : ""}`,
    [userId, ids],
  );
  return new Map(rows.map(({ id, ...revision }) => [id, revision]));
}

/**
 * Return a bounded canonical transcript, or null when the thread is absent/not owned. The inner
 * descending query selects the newest messages efficiently; the outer query restores conversation
 * order for model input.
 */
export async function getRecentChatMessagesForThreadForUser(
  userId: string,
  threadId: string,
  limit: number,
): Promise<ChatMessageRecord[] | null> {
  await ensureSchema();

  const safeLimit = Math.min(
    Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 1, 1),
    100,
  );
  const { rows } = await sql<{
    ownedThreadId: string;
    id: string | null;
    threadId: string | null;
    role: string | null;
    content: string | null;
    position: number | null;
    createdAt: string | null;
    metadata: unknown;
  }>`
    select
      t.id as "ownedThreadId",
      recent.id,
      recent."threadId",
      recent.role,
      recent.content,
      recent.position,
      recent."createdAt",
      recent.metadata
    from chat_threads t
    left join lateral (
      select
        m.id,
        m.thread_id as "threadId",
        m.role,
        left(regexp_replace(m.content, 'data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+', '[generated image data]', 'g'), 4000) AS content,
        m.position,
        m.created_at as "createdAt",
        jsonb_build_object(
          'contractEvidence', m.metadata_json->'contractEvidence',
          'contractEvidenceInvalid', m.metadata_json->'contractEvidenceInvalid',
          'toolActivity', m.metadata_json->'toolActivity',
          'files', m.metadata_json->'files',
          'agentMessages', CASE WHEN char_length((m.metadata_json->'agentMessages')::text) <= ${MAX_AGENT_STATE_CHARACTERS * 2}
            THEN m.metadata_json->'agentMessages' END,
          'webSources', CASE WHEN char_length((m.metadata_json->'webSources')::text) <= ${MAX_SOURCE_CATALOG_CHARACTERS * 2}
            THEN m.metadata_json->'webSources' END
        ) as metadata
      from chat_messages m
      where m.thread_id = t.id
      order by m.position desc, m.created_at desc
      limit ${safeLimit}
    ) recent on true
    where t.id = ${threadId}
      and t.user_id = ${userId}
    order by recent.position asc nulls first, recent."createdAt" asc nulls first
  `;

  if (!rows[0]) {
    return null;
  }

  const metadata = rows.map((row) => parseJsonObject(row.metadata));
  for (const item of metadata) if (item.contractEvidence === null) delete item.contractEvidence;
  const revisions = await currentContractRevisions(userId, metadata);
  const checkedRows = rows.map((row, index) => ({
    ...row, metadata: validateContractReplay(metadata[index]!, revisions),
  }));
  return (
    checkedRows
      .filter(
        (
          row,
        ): row is typeof row & {
          id: string;
          threadId: string;
          role: string;
          content: string;
          position: number;
          createdAt: string;
        } =>
          row.id !== null &&
          row.threadId !== null &&
          row.role !== null &&
          row.content !== null &&
          row.position !== null &&
          row.createdAt !== null,
      )
      // The chat loop replays this transcript into the next turn, so this is the one read that
      // genuinely needs it. Wrapped rather than passed by reference: Array.map supplies the index
      // as the second argument, which would silently select the wrong hydration mode.
      .map((row) => mapChatMessageRow(row, "include"))
  );
}

export async function getChatThreadByIdForUser(
  userId: string,
  threadId: string,
  beforePosition = 2147483647,
): Promise<ChatThreadDetailRecord | null> {
  await ensureSchema();

  const { rows: threadRows } = await sql<{
    id: string;
    userId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
  }>`
    select
      id,
      user_id as "userId",
      title,
      created_at as "createdAt",
      updated_at as "updatedAt"
    from chat_threads
    where id = ${threadId}
      and user_id = ${userId}
    limit 1
  `;

  const thread = threadRows[0];
  if (!thread) {
    return null;
  }

  // Drop the tool transcript and source catalog here. The thread view never renders them, and the
  // next turn reloads them through getRecentChatMessagesForThreadForUser.
  const { rows: messageRows } = await sql<{
    id: string;
    threadId: string;
    role: string;
    content: string;
    position: number;
    createdAt: string;
    metadata: unknown;
  }>`
    select
      id,
      thread_id as "threadId",
      role,
      CASE WHEN content LIKE '![Generated image](data:image/png;base64,%'
        THEN '![Generated image](/api/chat/threads/' || thread_id || '/images/' || id || ')'
        ELSE content END AS content,
      position,
      created_at as "createdAt",
      metadata_json - 'agentMessages' - 'webSources' as "metadata"
    from chat_messages
    where thread_id = ${threadId}
    and position < ${beforePosition}
    order by position desc, created_at desc
    limit 51
  `;

  return {
    ...thread,
    messages: messageRows
      .slice(0, 50)
      .reverse()
      .map((row) => mapChatMessageRow(row, "omit")),
    hasMore: messageRows.length > 50,
  };
}

/** Atomically append a turn and generated files under the owning thread's row lock. */
export async function appendChatMessagesToThread(input: {
  userId: string;
  threadId: string;
  generatedFiles?: GeneratedChatFile[];
  /** Applied only to an untitled thread's first saved turn, under the same row lock. */
  generatedTitle?: string | null;
  messages: Array<{
    role: ChatMessageRole;
    content: string;
    metadata?: JsonObject | null;
  }>;
}): Promise<ChatMessageRecord[]> {
  await ensureSchema();

  const cleanedMessages = input.messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
      metadata: message.metadata
        ? {
            ...message.metadata,
            agentMessages: compactAgentMessages(message.metadata.agentMessages),
            webSources: parseWebSources(message.metadata.webSources),
          }
        : null,
    }))
    .filter((message) => message.content.length > 0);

  if (!cleanedMessages.length) {
    return [];
  }

  // Use a dedicated client with a transaction + row-level lock to prevent
  // concurrent inserts from producing duplicate position values.
  const client = await sql.connect();
  try {
    await client.query("BEGIN");

    // Lock the thread row, scoped by user, so concurrent appends serialize here AND ownership is
    // enforced atomically in the same statement — no separate pre-check round-trip, no TOCTOU.
    const { rowCount: lockedThreadCount } = await client.query(
      "SELECT id FROM chat_threads WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [input.threadId, input.userId],
    );

    if (!lockedThreadCount) {
      await client.query("ROLLBACK");
      throw new ChatThreadNotFoundError();
    }

    // Original uploads are staged under this thread; generated downloads commit with the turn.
    for (const file of input.generatedFiles ?? []) {
      await client.query(
        "INSERT INTO chat_files(id, thread_id, filename, media_type, file_data, text_content) VALUES ($1, $2, $3, $4, decode($5, 'base64'), $6)",
        [file.id, input.threadId, file.name, file.mediaType, file.data, file.text],
      );
    }

    // Contract row locks serialize receipt validation with uploads/deletions. If a deletion
    // already committed, the missing row invalidates the transcript before it can be inserted.
    const revisions = await currentContractRevisions(
      input.userId, cleanedMessages.map((message) => message.metadata ?? {}), client,
    );
    for (const message of cleanedMessages) {
      if (message.metadata) {
        message.metadata = validateContractReplay(message.metadata, revisions) as typeof message.metadata;
      }
    }

    // Move every inline generated image out of the transcript text into chat_attachments, so a
    // reply that mixes prose and images stays small and each image is served by its own route.
    const inlineImage =
      /!\[Generated image\]\(data:image\/png;base64,([A-Za-z0-9+/=]+)\)/g;
    for (const message of cleanedMessages) {
      if (message.role !== "assistant") continue;
      const images = [...message.content.matchAll(inlineImage)];
      if (!images.length) continue;
      const replacements = new Map<string, string>();
      for (const image of images) {
        if (replacements.has(image[0])) continue;
        const imageId = randomUUID();
        await client.query(
          "INSERT INTO chat_attachments(id, thread_id, image_data) VALUES ($1, $2, decode($3, 'base64'))",
          [imageId, input.threadId, image[1]!],
        );
        replacements.set(
          image[0],
          `![Generated image](/api/chat/threads/${input.threadId}/images/${imageId})`,
        );
      }
      message.content = message.content.replace(
        inlineImage,
        (match) => replacements.get(match) ?? match,
      );
    }

    const posResult = await client.query(
      `SELECT coalesce(max(position), 0)::integer AS "basePosition"
       FROM chat_messages WHERE thread_id = $1`,
      [input.threadId],
    );
    const basePosition: number = posResult.rows[0]?.basePosition ?? 0;

    // Insert all messages in one round-trip. WITH ORDINALITY yields a 1-based `ord`, so
    // `basePosition + ord` reproduces the previous `basePosition + idx + 1` sequencing and order.
    // metadata is passed as a text[] of JSON (or null) and cast to jsonb per row.
    const inserted = await client.query(
      `INSERT INTO chat_messages (thread_id, role, content, position, metadata_json)
       SELECT $1, role, content, $2 + ord, metadata::jsonb
       FROM unnest($3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS t(role, content, metadata, ord)
       RETURNING id, thread_id AS "threadId", role, content, position, created_at AS "createdAt", metadata_json AS metadata`,
      [
        input.threadId,
        basePosition,
        cleanedMessages.map((message) => message.role),
        cleanedMessages.map((message) => message.content),
        cleanedMessages.map((message) =>
          message.metadata ? JSON.stringify(message.metadata) : null,
        ),
      ],
    );

    await client.query(
      `UPDATE chat_threads SET updated_at = now(),
         title = CASE WHEN $3::integer = 0 AND title = 'New chat' AND $4::text IS NOT NULL
           THEN $4 ELSE title END
       WHERE id = $1 AND user_id = $2`,
      [
        input.threadId,
        input.userId,
        basePosition,
        input.generatedTitle?.trim() || null,
      ],
    );

    await client.query("COMMIT");
    return inserted.rows.map((row) => mapChatMessageRow(row, "omit"));
  } catch (err) {
    // Swallow rollback failures: when the try failed because the connection died, ROLLBACK throws
    // too and would replace `err` with a generic connection error, hiding the real cause.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Check thread ownership before performing expensive upload extraction. */
export async function isChatThreadOwnedByUser(userId: string, threadId: string): Promise<boolean> {
  await ensureSchema();
  const result = await sql.query("SELECT id FROM chat_threads WHERE id = $1 AND user_id = $2", [threadId, userId]);
  return Boolean(result.rowCount);
}

/** Store an upload under an owner-scoped lock, enforcing the thread's 100-file cap atomically. */
export async function saveChatFileForUser(input: {
  userId: string; threadId: string; file: ChatDocument; data: Buffer;
}): Promise<ChatFileInfo | null> {
  await ensureSchema();
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query("SELECT id FROM chat_threads WHERE id = $1 AND user_id = $2 FOR UPDATE", [input.threadId, input.userId]);
    if (!owned.rowCount) { await client.query("ROLLBACK"); return null; }
    const count = await client.query<{ count: number }>("SELECT count(*)::integer AS count FROM chat_files WHERE thread_id = $1", [input.threadId]);
    if (count.rows[0]!.count >= 100) throw new Error("This chat has reached its 100-file limit. Start a new chat.");
    const file = input.file;
    await client.query("INSERT INTO chat_files(id, thread_id, filename, media_type, file_data, text_content, warning) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [file.id, input.threadId, file.name, file.mediaType, input.data, file.text, file.warning ?? null]);
    await client.query("COMMIT");
    return savedChatFile(file, input.threadId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

/** Load extracted text only for requested files in the caller's own thread. */
export async function getChatDocumentsForUser(userId: string, threadId: string, ids: readonly string[]): Promise<ChatDocument[]> {
  if (!ids.length) return [];
  await ensureSchema();
  const { rows } = await sql.query<ChatDocument>(
    `SELECT f.id, f.filename AS name, f.media_type AS "mediaType", octet_length(f.file_data) AS size, f.text_content AS text, f.warning
     FROM chat_files f JOIN chat_threads t ON t.id = f.thread_id
     WHERE t.user_id = $1 AND t.id = $2 AND f.id = ANY($3::uuid[])`, [userId, threadId, [...new Set(ids)]]);
  return rows.map(({ warning, ...file }) => ({ ...file, ...(warning ? { warning } : {}) }));
}

/** Fetch original download bytes with ownership and thread membership checked in SQL. */
export async function getChatFileForUser(userId: string, threadId: string, fileId: string): Promise<{ name: string; mediaType: string; data: Buffer } | null> {
  await ensureSchema();
  const { rows } = await sql.query<{ name: string; mediaType: string; data: Buffer }>(
    `SELECT f.filename AS name, f.media_type AS "mediaType", f.file_data AS data
     FROM chat_files f JOIN chat_threads t ON t.id = f.thread_id
     WHERE t.user_id = $1 AND t.id = $2 AND f.id = $3`, [userId, threadId, fileId]);
  return rows[0] ?? null;
}

export async function getChatImageForUser(
  userId: string,
  threadId: string,
  imageId: string,
): Promise<Buffer | null> {
  await ensureSchema();
  const { rows } = await sql.query<{ image: Buffer }>(
    `SELECT a.image_data AS image FROM chat_attachments a JOIN chat_threads t ON t.id = a.thread_id
     WHERE a.id = $1 AND t.id = $2 AND t.user_id = $3
     UNION ALL
     SELECT decode(substring(m.content from 'base64,([A-Za-z0-9+/=]+)'), 'base64') AS image
     FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
     WHERE m.id = $1 AND t.id = $2 AND t.user_id = $3
       AND m.content LIKE '![Generated image](data:image/png;base64,%' LIMIT 1`,
    [imageId, threadId, userId],
  );
  return rows[0]?.image ?? null;
}

export async function deleteChatThreadForUser(input: {
  userId: string;
  threadId: string;
  onlyIfEmpty?: boolean;
}): Promise<boolean> {
  await ensureSchema();
  if (input.onlyIfEmpty) {
    // Serialize abandoned-draft cleanup with generation startup and message appends.
    const release = await claimGenerationOperation(input.userId, "chat", input.threadId, 30);
    if (!release) return false;
    try {
      const client = await sql.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query(
          "SELECT id FROM chat_threads WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [input.threadId, input.userId],
        );
        if (!locked.rowCount) {
          await client.query("ROLLBACK");
          return false;
        }
        // A fresh statement after the row lock sees messages committed by an earlier appender.
        const deleted = await client.query(
          `DELETE FROM chat_threads WHERE id = $1 AND user_id = $2
           AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE thread_id = $1)`,
          [input.threadId, input.userId],
        );
        await client.query("COMMIT");
        return Boolean(deleted.rowCount);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } finally {
      await release();
    }
  }
  return Boolean(
    (
      await sql.query(
        "DELETE FROM chat_threads WHERE id = $1 AND user_id = $2",
        [input.threadId, input.userId],
      )
    ).rowCount,
  );
}
