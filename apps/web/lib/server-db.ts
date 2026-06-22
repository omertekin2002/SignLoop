import { sql } from "@vercel/postgres";
import type { PrimaryModel } from "@/lib/model-settings";
import type { PersonalityMode } from "@/lib/personality-settings";

type JsonObject = Record<string, unknown>;

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

function clampPagination(opts?: PaginationOptions): { limit: number; offset: number } {
  // Number.isFinite guards against NaN (e.g. ?limit=abc -> Number(...) === NaN), which the
  // `?? DEFAULT` nullish coalescing does not catch and would otherwise reach the SQL LIMIT.
  const rawLimit = Number.isFinite(opts?.limit) ? (opts!.limit as number) : DEFAULT_PAGE_LIMIT;
  const rawOffset = Number.isFinite(opts?.offset) ? (opts!.offset as number) : 0;
  const limit = Math.min(Math.max(rawLimit, 1), MAX_PAGE_LIMIT);
  const offset = Math.max(rawOffset, 0);
  return { limit, offset };
}

let schemaReadyPromise: Promise<void> | null = null;

// Bootstraps the schema at runtime with idempotent CREATE ... IF NOT EXISTS statements. This
// mirrors the SQL in db/migrations/*.sql (applied by db/migrate.js); keep the two in sync when
// changing the schema.
async function ensureSchema(): Promise<void> {
  if (schemaReadyPromise) {
    return schemaReadyPromise;
  }

  schemaReadyPromise = (async () => {
    await sql`create extension if not exists "pgcrypto"`;

    await sql`
      create table if not exists projects (
        id uuid primary key default gen_random_uuid(),
        user_id text not null,
        title text not null,
        description text,
        status text not null default 'active',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;

    await sql`
      create index if not exists projects_user_id_idx
      on projects (user_id)
    `;

    await sql`
      create table if not exists contracts (
        id uuid primary key default gen_random_uuid(),
        user_id text not null,
        project_id uuid,
        title text not null default 'Untitled Contract',
        status text not null default 'DRAFT',
        text_content text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;

    await sql`
      create index if not exists contracts_user_id_idx
      on contracts (user_id)
    `;
    await sql`
      create index if not exists contracts_project_id_idx
      on contracts (project_id)
    `;
    await sql`
      create index if not exists contracts_created_at_idx
      on contracts (created_at desc)
    `;

    await sql`
      create table if not exists analyses (
        id uuid primary key default gen_random_uuid(),
        contract_id uuid not null,
        risk_badge text,
        result_json jsonb not null,
        llm_provider text,
        llm_model text,
        llm_prompt_tokens integer,
        llm_completion_tokens integer,
        processing_time_ms integer,
        created_at timestamptz not null default now()
      )
    `;

    await sql`
      create index if not exists analyses_contract_id_idx
      on analyses (contract_id)
    `;
    await sql`
      create index if not exists analyses_created_at_idx
      on analyses (created_at desc)
    `;

    await sql`
      create table if not exists context_documents (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null,
        title text not null,
        document_type text not null default 'other',
        storage_key text,
        bucket text,
        original_filename text,
        content_type text,
        size_bytes integer,
        extracted_text text,
        word_count integer,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;

    await sql`
      create index if not exists context_documents_project_id_idx
      on context_documents (project_id)
    `;
    await sql`
      create index if not exists context_documents_created_at_idx
      on context_documents (created_at desc)
    `;

    await sql`
      create table if not exists contract_files (
        id uuid primary key default gen_random_uuid(),
        user_id text not null,
        project_id uuid,
        title text not null default 'Untitled Contract',
        file_name text not null,
        blob_path text,
        content_type text,
        size_bytes integer,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;

    // For legacy databases where project_id was originally created as text. The ALTER takes an
    // ACCESS EXCLUSIVE lock, so only run it when the column is not already uuid (otherwise this
    // would needlessly lock the table on every cold start of a new serverless process).
    await sql`
      do $$
      begin
        if exists (
          select 1 from information_schema.columns
          where table_name = 'contract_files'
            and column_name = 'project_id'
            and data_type <> 'uuid'
        ) then
          alter table contract_files
            alter column project_id type uuid using project_id::uuid;
        end if;
      end $$
    `;

    await sql`
      alter table contract_files
      add column if not exists contract_id uuid
    `;
    await sql`
      alter table contract_files
      add column if not exists storage_key text
    `;
    await sql`
      alter table contract_files
      add column if not exists bucket text
    `;
    await sql`
      alter table contract_files
      add column if not exists extraction_method text
    `;
    await sql`
      alter table contract_files
      add column if not exists extraction_confidence double precision
    `;

    await sql`
      create index if not exists contract_files_user_id_idx
      on contract_files (user_id)
    `;
    await sql`
      create index if not exists contract_files_project_id_idx
      on contract_files (project_id)
    `;
    await sql`
      create index if not exists contract_files_contract_id_idx
      on contract_files (contract_id)
    `;

    await sql`
      create table if not exists user_settings (
        user_id text primary key,
        primary_model text,
        personality text,
        updated_at timestamptz not null default now()
      )
    `;

    await sql`
      alter table user_settings
      add column if not exists personality text
    `;

    await sql`
      create table if not exists chat_threads (
        id uuid primary key default gen_random_uuid(),
        user_id text not null,
        title text not null default 'New chat',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;

    await sql`
      create index if not exists chat_threads_user_id_idx
      on chat_threads (user_id)
    `;
    await sql`
      create index if not exists chat_threads_updated_at_idx
      on chat_threads (updated_at desc)
    `;

    await sql`
      create table if not exists chat_messages (
        id uuid primary key default gen_random_uuid(),
        thread_id uuid not null,
        role text not null,
        content text not null,
        position integer not null default 0,
        metadata_json jsonb,
        created_at timestamptz not null default now()
      )
    `;

    await sql`
      create index if not exists chat_messages_thread_id_idx
      on chat_messages (thread_id)
    `;
    await sql`
      create index if not exists chat_messages_thread_position_idx
      on chat_messages (thread_id, position)
    `;
    await sql`
      create index if not exists chat_messages_thread_created_at_idx
      on chat_messages (thread_id, created_at)
    `;
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
  keyPoints: string[];
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
  text: string | null;
  analyses: AnalysisRecord[];
  latestAnalysis: AnalysisRecord | null;
};

export type ProjectSummaryRecord = {
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
  }>;
  contextDocuments: Array<{ id: string }>;
};

export type ProjectDetailRecord = {
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

export type UserSettingsRecord = {
  userId: string;
  primaryModel: PrimaryModel | null;
  personality: PersonalityMode | null;
  updatedAt: string;
};

export type ChatMessageRole = "system" | "user" | "assistant";

export type ChatMessageRecord = {
  id: string;
  threadId: string;
  role: ChatMessageRole;
  content: string;
  position: number;
  createdAt: string;
};

export type ChatThreadSummaryRecord = {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  messageCount: number;
};

export type ChatThreadDetailRecord = {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessageRecord[];
};

type UploadedContractFileInput = {
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
  riskBadge: string | null;
  resultJson: JsonObject;
  llmProvider: string | null;
  llmModel: string | null;
  llmPromptTokens?: number | null;
  llmCompletionTokens?: number | null;
  processingTimeMs?: number | null;
};

type NewContextDocumentInput = {
  userId: string;
  projectId: string;
  title: string;
  documentType: string;
  storageKey: string;
  bucket: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
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

function mapAnalysisRow(row: {
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
}): AnalysisRecord {
  const resultJson = parseJsonObject(row.resultJson);
  const rawKeyPoints = resultJson.key_points;
  const keyPoints = Array.isArray(rawKeyPoints)
    ? rawKeyPoints.filter((item): item is string => typeof item === "string")
    : [];

  return {
    id: row.id,
    contractId: row.contractId,
    riskBadge: row.riskBadge,
    resultJson,
    keyPoints,
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
      order by created_at desc
      limit ${limit} offset ${offset}
    `,
    sql<{ count: number }>`
      select count(*)::integer as count
      from contracts
      where user_id = ${userId}
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

  if (validatedProjectId) {
    const { rows: projectRows } = await sql<{ id: string }>`
      select id
      from projects
      where id = ${validatedProjectId}
        and user_id = ${input.userId}
      limit 1
    `;

    if (!projectRows[0]) {
      throw new Error("Project not found");
    }
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
): Promise<ContractRecord | null> {
  await ensureSchema();

  const { rows: contractRows } = await sql<ContractSummaryRecord & { text: string | null }>`
    select
      id,
      user_id as "userId",
      project_id as "projectId",
      title,
      status,
      text_content as "text",
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

  const { rows: analysisRows } = await sql<{
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
  }>`
    select
      id,
      contract_id as "contractId",
      risk_badge as "riskBadge",
      result_json as "resultJson",
      llm_provider as "llmProvider",
      llm_model as "llmModel",
      llm_prompt_tokens as "llmPromptTokens",
      llm_completion_tokens as "llmCompletionTokens",
      processing_time_ms as "processingTimeMs",
      created_at as "createdAt"
    from analyses
    where contract_id = ${contractId}
    order by created_at desc
  `;

  const analyses = analysisRows.map(mapAnalysisRow);
  const latestAnalysis = analyses[0] ?? null;

  return {
    ...contract,
    analyses,
    latestAnalysis,
  };
}

export async function saveContractExtractedText(input: {
  userId: string;
  contractId: string;
  text: string;
}): Promise<boolean> {
  await ensureSchema();

  const { rowCount } = await sql`
    update contracts
    set
      text_content = ${input.text},
      status = 'DRAFT',
      updated_at = now()
    where id = ${input.contractId}
      and user_id = ${input.userId}
  `;

  return (rowCount ?? 0) > 0;
}

export async function addUploadedContractFile(input: UploadedContractFileInput): Promise<void> {
  await ensureSchema();

  // storage_key is the canonical column; the legacy blob_path column is left null for new rows
  // (read paths use coalesce(storage_key, blob_path) to tolerate older rows).
  await sql`
    insert into contract_files (
      user_id,
      project_id,
      contract_id,
      title,
      file_name,
      storage_key,
      bucket,
      content_type,
      size_bytes,
      extraction_method,
      extraction_confidence
    )
    values (
      ${input.userId},
      ${input.projectId},
      ${input.contractId},
      ${input.title},
      ${input.fileName},
      ${input.storageKey},
      ${input.bucket},
      ${input.contentType},
      ${input.sizeBytes},
      ${input.extractionMethod},
      ${input.extractionConfidence}
    )
  `;
}

export async function createAnalysisForContract(input: NewAnalysisInput): Promise<void> {
  await ensureSchema();

  const { rows: contractRows } = await sql<{ id: string }>`
    select id
    from contracts
    where id = ${input.contractId}
      and user_id = ${input.userId}
    limit 1
  `;

  if (!contractRows[0]) {
    throw new Error("Contract not found");
  }

  await sql`
    insert into analyses (
      contract_id,
      risk_badge,
      result_json,
      llm_provider,
      llm_model,
      llm_prompt_tokens,
      llm_completion_tokens,
      processing_time_ms
    )
    values (
      ${input.contractId},
      ${input.riskBadge},
      ${JSON.stringify(input.resultJson)},
      ${input.llmProvider},
      ${input.llmModel},
      ${input.llmPromptTokens ?? null},
      ${input.llmCompletionTokens ?? null},
      ${input.processingTimeMs ?? null}
    )
  `;

  await sql`
    update contracts
    set
      status = 'ANALYZED',
      updated_at = now()
    where id = ${input.contractId}
      and user_id = ${input.userId}
  `;
}

export async function deleteAnalysisForContract(input: {
  userId: string;
  contractId: string;
  analysisId: string;
}): Promise<boolean> {
  await ensureSchema();

  const { rows } = await sql<{ id: string }>`
    delete from analyses
    using contracts
    where analyses.id = ${input.analysisId}
      and analyses.contract_id = ${input.contractId}
      and contracts.id = analyses.contract_id
      and contracts.user_id = ${input.userId}
    returning analyses.id
  `;

  return !!rows[0];
}

/**
 * Collect all storage keys associated with a contract's uploaded files.
 * Call this *before* deleting DB records so keys are available for storage
 * cleanup even if the DB delete succeeds first.
 */
export async function getContractStorageKeys(
  userId: string,
  contractId: string,
): Promise<string[]> {
  await ensureSchema();

  const { rows } = await sql<{ storageKey: string | null }>`
    select coalesce(cf.storage_key, cf.blob_path) as "storageKey"
    from contract_files cf
    inner join contracts c on c.id = cf.contract_id
    where cf.contract_id = ${contractId}
      and c.user_id = ${userId}
  `;

  return rows
    .map((r) => r.storageKey)
    .filter((v): v is string => Boolean(v));
}

/**
 * Collect all storage keys associated with a project — both contract files
 * and context documents.
 */
export async function getProjectStorageKeys(
  userId: string,
  projectId: string,
): Promise<string[]> {
  await ensureSchema();

  const { rows: fileRows } = await sql<{ storageKey: string | null }>`
    select coalesce(cf.storage_key, cf.blob_path) as "storageKey"
    from contract_files cf
    inner join contracts c on c.id = cf.contract_id
    where c.project_id = ${projectId}
      and c.user_id = ${userId}
  `;

  // Join projects so the context-document branch is self-guarding on ownership, mirroring the
  // contract_files branch above (context_documents has no user_id column of its own).
  const { rows: contextRows } = await sql<{ storageKey: string | null }>`
    select cd.storage_key as "storageKey"
    from context_documents cd
    inner join projects p on p.id = cd.project_id
    where cd.project_id = ${projectId}
      and p.user_id = ${userId}
  `;

  return [...fileRows, ...contextRows]
    .map((r) => r.storageKey)
    .filter((v): v is string => Boolean(v));
}

/**
 * Delete a single contract and its children (analyses, files) using the
 * provided client so callers can include this in a wider transaction.
 * Returns the storage keys that should be removed *after* the transaction
 * commits.
 */
async function deleteContractCascade(
  client: import("@vercel/postgres").VercelPoolClient,
  userId: string,
  contractId: string,
): Promise<string[]> {
  const { rows: fileRows } = await client.query<{ storageKey: string | null }>(
    `SELECT coalesce(storage_key, blob_path) AS "storageKey"
     FROM contract_files WHERE contract_id = $1`,
    [contractId],
  );

  await client.query("DELETE FROM analyses WHERE contract_id = $1", [contractId]);
  await client.query("DELETE FROM contract_files WHERE contract_id = $1", [contractId]);
  await client.query("DELETE FROM contracts WHERE id = $1 AND user_id = $2", [contractId, userId]);

  return fileRows
    .map((row) => row.storageKey)
    .filter((value): value is string => Boolean(value));
}

export async function deleteContractForUser(input: {
  userId: string;
  contractId: string;
}): Promise<{ deleted: boolean; storageKeys: string[] }> {
  await ensureSchema();

  const { rows: contractRows } = await sql<{ id: string }>`
    select id
    from contracts
    where id = ${input.contractId}
      and user_id = ${input.userId}
    limit 1
  `;

  if (!contractRows[0]) {
    return { deleted: false, storageKeys: [] };
  }

  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    const storageKeys = await deleteContractCascade(client, input.userId, input.contractId);
    await client.query("COMMIT");
    return { deleted: true, storageKeys };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
      updated_at as "updatedAt"
  `;

  const created = rows[0];
  if (!created) {
    throw new Error("Failed to create project");
  }

  return {
    ...created,
    contracts: [],
    contextDocuments: [],
  };
}

export async function listProjectsByUserId(
  userId: string,
  pagination?: PaginationOptions,
): Promise<PaginatedResult<ProjectSummaryRecord>> {
  await ensureSchema();

  const { limit, offset } = clampPagination(pagination);

  const [{ rows: projectRows }, { rows: countRows }] = await Promise.all([
    sql<Omit<ProjectSummaryRecord, "contracts" | "contextDocuments">>`
      select
        id,
        user_id as "userId",
        title,
        description,
        status,
        created_at as "createdAt",
        updated_at as "updatedAt"
      from projects
      where user_id = ${userId}
      order by created_at desc
      limit ${limit} offset ${offset}
    `,
    sql<{ count: number }>`
      select count(*)::integer as count
      from projects
      where user_id = ${userId}
    `,
  ]);

  const total = countRows[0]?.count ?? 0;

  if (projectRows.length === 0) {
    return { data: [], total, limit, offset };
  }

  const projectIdsLiteral = `{${projectRows.map((p) => p.id).join(",")}}`;

  const { rows: contractRows } = await sql<{
    projectId: string;
    id: string;
    title: string;
    status: string;
    createdAt: string;
  }>`
    select
      project_id as "projectId",
      id,
      title,
      status,
      created_at as "createdAt"
    from contracts
    where project_id = any(${projectIdsLiteral}::uuid[])
    order by created_at desc
  `;

  const { rows: contextDocRows } = await sql<{
    projectId: string;
    id: string;
  }>`
    select
      project_id as "projectId",
      id
    from context_documents
    where project_id = any(${projectIdsLiteral}::uuid[])
    order by created_at desc
  `;

  const contractsByProject = new Map<string, ProjectSummaryRecord["contracts"]>();
  for (const row of contractRows) {
    const list = contractsByProject.get(row.projectId) ?? [];
    list.push({ id: row.id, title: row.title, status: row.status, createdAt: row.createdAt });
    contractsByProject.set(row.projectId, list);
  }

  const contextDocsByProject = new Map<string, ProjectSummaryRecord["contextDocuments"]>();
  for (const row of contextDocRows) {
    const list = contextDocsByProject.get(row.projectId) ?? [];
    list.push({ id: row.id });
    contextDocsByProject.set(row.projectId, list);
  }

  const data = projectRows.map((project) => ({
    ...project,
    contracts: contractsByProject.get(project.id) ?? [],
    contextDocuments: contextDocsByProject.get(project.id) ?? [],
  }));

  return { data, total, limit, offset };
}

async function isProjectOwnedByUser(userId: string, projectId: string): Promise<boolean> {
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

  const [{ rows: contractRows }, { rows: contextDocuments }] = await Promise.all([
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
      order by created_at desc
    `,
    sql<{
      id: string;
      title: string;
      documentType: string;
      originalFilename: string | null;
      fileSize: number | null;
      wordCount: number | null;
      createdAt: string;
    }>`
      select
        id,
        title,
        document_type as "documentType",
        original_filename as "originalFilename",
        size_bytes as "fileSize",
        word_count as "wordCount",
        created_at as "createdAt"
      from context_documents
      where project_id = ${projectId}
      order by created_at asc
    `,
  ]);

  const analysesByContract = new Map<
    string,
    Array<{ id: string; riskBadge: string | null }>
  >();

  if (contractRows.length > 0) {
    const contractIdsLiteral = `{${contractRows.map((c) => c.id).join(",")}}`;

    const { rows: analysisRows } = await sql<{
      contractId: string;
      id: string;
      riskBadge: string | null;
    }>`
      select
        contract_id as "contractId",
        id,
        risk_badge as "riskBadge"
      from analyses
      where contract_id = any(${contractIdsLiteral}::uuid[])
      order by created_at desc
    `;

    for (const row of analysisRows) {
      const list = analysesByContract.get(row.contractId) ?? [];
      list.push({ id: row.id, riskBadge: row.riskBadge });
      analysesByContract.set(row.contractId, list);
    }
  }

  const contracts = contractRows.map((contract) => ({
    ...contract,
    analyses: analysesByContract.get(contract.id) ?? [],
  }));

  return {
    ...project,
    contracts,
    contextDocuments,
  };
}

export async function addContextDocumentToProject(
  input: NewContextDocumentInput,
): Promise<{ id: string }> {
  await ensureSchema();

  const owned = await isProjectOwnedByUser(input.userId, input.projectId);
  if (!owned) {
    throw new Error("Project not found");
  }

  const { rows } = await sql<{ id: string }>`
    insert into context_documents (
      project_id,
      title,
      document_type,
      storage_key,
      bucket,
      original_filename,
      content_type,
      size_bytes,
      extracted_text,
      word_count
    )
    values (
      ${input.projectId},
      ${input.title},
      ${input.documentType},
      ${input.storageKey},
      ${input.bucket},
      ${input.originalFilename},
      ${input.contentType},
      ${input.sizeBytes},
      ${input.extractedText},
      ${input.wordCount}
    )
    returning id
  `;

  const created = rows[0];
  if (!created) {
    throw new Error("Failed to create context document");
  }

  return created;
}

/**
 * Look up the storage key for a context document without deleting it.
 */
export async function getContextDocumentStorageKey(
  userId: string,
  projectId: string,
  documentId: string,
): Promise<string | null> {
  await ensureSchema();

  const owned = await isProjectOwnedByUser(userId, projectId);
  if (!owned) {
    return null;
  }

  const { rows } = await sql<{ storageKey: string | null }>`
    select storage_key as "storageKey"
    from context_documents
    where id = ${documentId}
      and project_id = ${projectId}
    limit 1
  `;

  return rows[0]?.storageKey ?? null;
}

export async function deleteContextDocumentFromProject(input: {
  userId: string;
  projectId: string;
  documentId: string;
}): Promise<{ deleted: boolean; storageKey: string | null }> {
  await ensureSchema();

  const owned = await isProjectOwnedByUser(input.userId, input.projectId);
  if (!owned) {
    return { deleted: false, storageKey: null };
  }

  const { rows } = await sql<{ id: string; storageKey: string | null }>`
    delete from context_documents
    where id = ${input.documentId}
      and project_id = ${input.projectId}
    returning
      id,
      storage_key as "storageKey"
  `;

  if (!rows[0]) {
    return { deleted: false, storageKey: null };
  }

  return {
    deleted: true,
    storageKey: rows[0].storageKey,
  };
}

export async function deleteProjectForUser(input: {
  userId: string;
  projectId: string;
}): Promise<{ deleted: boolean; storageKeys: string[] }> {
  await ensureSchema();

  const owned = await isProjectOwnedByUser(input.userId, input.projectId);
  if (!owned) {
    return { deleted: false, storageKeys: [] };
  }

  const client = await sql.connect();
  try {
    await client.query("BEGIN");

    // Collect storage keys for all contract files in this project
    const { rows: contractRows } = await client.query<{ id: string }>(
      "SELECT id FROM contracts WHERE project_id = $1 AND user_id = $2",
      [input.projectId, input.userId],
    );

    const storageKeys: string[] = [];
    for (const contract of contractRows) {
      const keys = await deleteContractCascade(client, input.userId, contract.id);
      storageKeys.push(...keys);
    }

    // Collect storage keys for context documents
    const { rows: contextRows } = await client.query<{ storageKey: string | null }>(
      `SELECT storage_key AS "storageKey" FROM context_documents WHERE project_id = $1`,
      [input.projectId],
    );
    storageKeys.push(
      ...contextRows
        .map((row) => row.storageKey)
        .filter((value): value is string => Boolean(value)),
    );

    await client.query("DELETE FROM context_documents WHERE project_id = $1", [input.projectId]);
    await client.query("DELETE FROM projects WHERE id = $1 AND user_id = $2", [input.projectId, input.userId]);

    await client.query("COMMIT");
    return { deleted: true, storageKeys };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
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

export async function upsertUserPrimaryModel(input: {
  userId: string;
  primaryModel: PrimaryModel;
}): Promise<UserSettingsRecord> {
  await ensureSchema();

  const { rows } = await sql<UserSettingsRecord>`
    insert into user_settings (
      user_id,
      primary_model,
      personality,
      updated_at
    )
    values (
      ${input.userId},
      ${input.primaryModel},
      null,
      now()
    )
    on conflict (user_id)
    do update set
      primary_model = excluded.primary_model,
      updated_at = now()
    returning
      user_id as "userId",
      primary_model as "primaryModel",
      personality as "personality",
      updated_at as "updatedAt"
  `;

  const saved = rows[0];
  if (!saved) {
    throw new Error("Failed to save user settings");
  }

  return saved;
}

export async function upsertUserPersonality(input: {
  userId: string;
  personality: PersonalityMode;
}): Promise<UserSettingsRecord> {
  await ensureSchema();

  const { rows } = await sql<UserSettingsRecord>`
    insert into user_settings (
      user_id,
      primary_model,
      personality,
      updated_at
    )
    values (
      ${input.userId},
      null,
      ${input.personality},
      now()
    )
    on conflict (user_id)
    do update set
      personality = excluded.personality,
      updated_at = now()
    returning
      user_id as "userId",
      primary_model as "primaryModel",
      personality as "personality",
      updated_at as "updatedAt"
  `;

  const saved = rows[0];
  if (!saved) {
    throw new Error("Failed to save user settings");
  }

  return saved;
}

function mapChatMessageRow(row: {
  id: string;
  threadId: string;
  role: string;
  content: string;
  position: number;
  createdAt: string;
}): ChatMessageRecord {
  const role: ChatMessageRole =
    row.role === "system" || row.role === "assistant" ? row.role : "user";

  return {
    id: row.id,
    threadId: row.threadId,
    role,
    content: row.content,
    position: row.position,
    createdAt: row.createdAt,
  };
}

async function isChatThreadOwnedByUser(userId: string, threadId: string): Promise<boolean> {
  await ensureSchema();

  const { rows } = await sql<{ id: string }>`
    select id
    from chat_threads
    where id = ${threadId}
      and user_id = ${userId}
    limit 1
  `;

  return !!rows[0];
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
      null::text as "lastMessagePreview",
      null::timestamptz as "lastMessageAt",
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
        case
          when lm.content is null then null
          when char_length(lm.content) > 120 then substring(lm.content from 1 for 117) || '...'
          else lm.content
        end as "lastMessagePreview",
        lm.created_at as "lastMessageAt",
        coalesce(mc.message_count, 0)::integer as "messageCount"
      from chat_threads t
      left join lateral (
        select
          content,
          created_at
        from chat_messages
        where thread_id = t.id
        order by position desc, created_at desc
        limit 1
      ) lm on true
      left join lateral (
        select count(*)::integer as message_count
        from chat_messages
        where thread_id = t.id
      ) mc on true
      where t.user_id = ${userId}
      order by coalesce(lm.created_at, t.updated_at) desc
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

export async function getChatThreadByIdForUser(
  userId: string,
  threadId: string
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

  const { rows: messageRows } = await sql<{
    id: string;
    threadId: string;
    role: string;
    content: string;
    position: number;
    createdAt: string;
  }>`
    select
      id,
      thread_id as "threadId",
      role,
      content,
      position,
      created_at as "createdAt"
    from chat_messages
    where thread_id = ${threadId}
    order by position asc, created_at asc
  `;

  return {
    ...thread,
    messages: messageRows.map(mapChatMessageRow),
  };
}

export async function appendChatMessagesToThread(input: {
  userId: string;
  threadId: string;
  messages: Array<{ role: ChatMessageRole; content: string }>;
}): Promise<void> {
  await ensureSchema();

  const owned = await isChatThreadOwnedByUser(input.userId, input.threadId);
  if (!owned) {
    throw new Error("Chat thread not found");
  }

  const cleanedMessages = input.messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);

  if (!cleanedMessages.length) {
    return;
  }

  // Use a dedicated client with a transaction + row-level lock to prevent
  // concurrent inserts from producing duplicate position values.
  const client = await sql.connect();
  try {
    await client.query("BEGIN");

    // Lock the thread row so concurrent appends serialize here.
    await client.query(
      "SELECT id FROM chat_threads WHERE id = $1 FOR UPDATE",
      [input.threadId],
    );

    const posResult = await client.query(
      `SELECT coalesce(max(position), 0)::integer AS "basePosition"
       FROM chat_messages WHERE thread_id = $1`,
      [input.threadId],
    );
    const basePosition: number = posResult.rows[0]?.basePosition ?? 0;

    for (const [idx, message] of cleanedMessages.entries()) {
      await client.query(
        `INSERT INTO chat_messages (thread_id, role, content, position, metadata_json)
         VALUES ($1, $2, $3, $4, null)`,
        [input.threadId, message.role, message.content, basePosition + idx + 1],
      );
    }

    await client.query(
      `UPDATE chat_threads SET updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [input.threadId, input.userId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteChatThreadForUser(input: {
  userId: string;
  threadId: string;
}): Promise<boolean> {
  await ensureSchema();

  const owned = await isChatThreadOwnedByUser(input.userId, input.threadId);
  if (!owned) {
    return false;
  }

  // Delete messages and the thread row in a single transaction so a failure cannot leave an
  // orphaned (message-less) thread — there are no FK cascades to fall back on.
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM chat_messages WHERE thread_id = $1`, [input.threadId]);
    await client.query(
      `DELETE FROM chat_threads WHERE id = $1 AND user_id = $2`,
      [input.threadId, input.userId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return true;
}
