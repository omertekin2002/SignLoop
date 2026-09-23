import {
  compactAgentMessages,
  parseAgentMessages,
  parseWebSources,
  MAX_AGENT_STATE_CHARACTERS,
  MAX_SOURCE_CATALOG_CHARACTERS,
} from "@/lib/chat-agent-history";
import { runMigrations } from "../db/migrations.js";
import { sql, type VercelPoolClient } from "@vercel/postgres";
import { randomUUID } from "node:crypto";
import type { PrimaryModel } from "@/lib/model-settings";
import type { PersonalityMode } from "@/lib/personality-settings";
import {
  ChatThreadNotFoundError,
  ContractRevisionChangedError,
  ProjectNotFoundError,
} from "@/lib/errors";

type JsonObject = Record<string, unknown>;

export async function claimGenerationOperation(
  userId: string,
  kind: "contract" | "chat",
  id: string,
  seconds: number,
): Promise<(() => Promise<void>) | null> {
  await ensureSchema();
  const entityKey = `${kind}:${userId}:${id}`;
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

export async function claimChatAdmission(input: {
  principal: string;
  hourlyLimit: number;
  concurrency: number;
  globalDailyLimit: number;
  globalConcurrency: number;
}): Promise<{ release: () => Promise<void> } | { retryAfter: number }> {
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
    const { rows } = await client.query<{
      active: number;
      own: number;
      daily: number;
      hourly: number;
    }>(
      `
      SELECT (SELECT count(*)::integer FROM chat_admissions) AS active,
        (SELECT count(*)::integer FROM chat_admissions WHERE principal = $1) AS own,
        coalesce((SELECT requests FROM chat_request_budgets WHERE bucket = 'global' AND window_start = date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0) AS daily,
        coalesce((SELECT requests FROM chat_request_budgets WHERE bucket = $1 AND window_start = date_trunc('hour', now())), 0) AS hourly`,
      [input.principal],
    );
    const state = rows[0]!;
    const retryAfter =
      state.daily >= input.globalDailyLimit
        ? 86400
        : state.hourly >= input.hourlyLimit
          ? 3600
          : state.active >= input.globalConcurrency ||
              state.own >= input.concurrency
            ? 30
            : 0;
    if (retryAfter) {
      await client.query("ROLLBACK");
      return { retryAfter };
    }
    await client.query(
      `INSERT INTO chat_request_budgets(bucket, window_start, requests)
      VALUES ('global', date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', 1), ($1, date_trunc('hour', now()), 1)
      ON CONFLICT (bucket, window_start) DO UPDATE SET requests = chat_request_budgets.requests + 1`,
      [input.principal],
    );
    await client.query(
      "INSERT INTO chat_admissions(token, principal, expires_at) VALUES ($1, $2, now() + interval '360 seconds')",
      [token, input.principal],
    );
    await client.query("COMMIT");
    return {
      release: async () => {
        await sql.query("DELETE FROM chat_admissions WHERE token = $1", [
          token,
        ]);
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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
async function ensureSchema(): Promise<void> {
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

export type ContractRecord = ContractSummaryRecord & {
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
  agentMessages?: import("ai").ModelMessage[];
  webSources?: import("@/lib/gemini-search").WebSearchSource[];
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

  const { rows } = await sql<ContractSummaryRecord>`
    insert into contracts (
      user_id,
      project_id,
      title,
      status
    )
    values (
      ${input.userId},
      ${validatedProjectId},
      ${input.title},
      'DRAFT'
    )
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

  const { rows: contractRows } = await sql<ContractSummaryRecord>`
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

export type ChatContractSummaryRecord = {
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

  const { rows } = await sql<ChatContractSummaryRecord>`
    select
      id,
      title,
      status,
      project_id as "projectId",
      updated_at as "updatedAt",
      coalesce(char_length(text_content), 0)::integer as "characterCount",
      extraction_warning as "extractionWarning"
    from contracts
    where user_id = ${userId}
      and strpos(lower(title), lower(${query})) > 0
    order by updated_at desc, id desc
    limit ${limit + 1}
    offset ${offset}
  `;

  return {
    contracts: rows.slice(0, limit),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

export type ChatContractTextRecord = {
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

  const { rows } = await sql<ChatContractTextRecord>`
    select
      id,
      title,
      status,
      text_content as "text",
      extraction_warning as "extractionWarning"
    from contracts
    where id = ${contractId}
      and user_id = ${userId}
    limit 1
  `;

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
  const { rows } = await sql<
    ChatContractTextRecord & { characterCount: number }
  >`
    SELECT id, title, status, substring(text_content FROM ${start + 1} FOR 12000) AS text,
      coalesce(char_length(text_content), 0)::integer AS "characterCount",
      extraction_warning AS "extractionWarning"
    FROM contracts WHERE id = ${contractId} AND user_id = ${userId} LIMIT 1
  `;
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
      order by a.created_at desc
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
      order by a.created_at desc
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
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestAnalysis: row.analysisId ? { id: row.analysisId } : null,
  };
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
    const deletingLatest = latest.rows[0]?.id === input.analysisId;

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

export async function deleteContractForUser(input: {
  userId: string;
  contractId: string;
}): Promise<{ deleted: boolean }> {
  await ensureSchema();
  const result = await sql.query(
    "DELETE FROM contracts WHERE id = $1 AND user_id = $2",
    [input.contractId, input.userId],
  );
  return { deleted: Boolean(result.rowCount) };
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
    values (
      ${input.userId},
      ${input.title},
      ${input.description ?? null},
      'active'
    )
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
      `select distinct on (contract_id)
        contract_id as "contractId",
        id,
        risk_badge as "riskBadge"
      from analyses
      where contract_id = any($1::uuid[])
      order by contract_id, created_at desc`,
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
  await ensureSchema();
  const result = await sql.query(
    "DELETE FROM projects WHERE id = $1 AND user_id = $2",
    [input.projectId, input.userId],
  );
  return { deleted: Boolean(result.rowCount) };
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
    VALUES (${input.userId}, ${input.primaryModel ?? null}, ${input.personality ?? null}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      primary_model = CASE WHEN ${input.primaryModel !== undefined} THEN excluded.primary_model ELSE user_settings.primary_model END,
      personality = CASE WHEN ${input.personality !== undefined} THEN excluded.personality ELSE user_settings.personality END,
      updated_at = now()
    RETURNING user_id AS "userId", primary_model AS "primaryModel", personality, updated_at AS "updatedAt"
  `;
  if (!rows[0]) throw new Error("Failed to save user settings");
  return rows[0];
}

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
    content: row.content,
    position: row.position,
    createdAt: row.createdAt,
    ...(replayState === "include"
      ? {
          agentMessages: parseAgentMessages(metadata.agentMessages),
          webSources: parseWebSources(metadata.webSources),
        }
      : {}),
    toolActivity: metadata.toolActivity,
    model,
    provider,
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
    values (
      ${input.userId},
      ${title}
    )
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

  return (
    rows
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

export async function appendChatMessagesToThread(input: {
  userId: string;
  threadId: string;
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
      `UPDATE chat_threads SET updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [input.threadId, input.userId],
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
}): Promise<boolean> {
  await ensureSchema();
  return Boolean(
    (
      await sql.query(
        "DELETE FROM chat_threads WHERE id = $1 AND user_id = $2",
        [input.threadId, input.userId],
      )
    ).rowCount,
  );
}
