import { sql } from '@vercel/postgres';
import { z } from 'zod';

const userIdSchema = z.string().min(1, 'userId is required');

const insertContractFileSchema = z.object({
  userId: userIdSchema,
  projectId: z.string().min(1).optional().nullable(),
  title: z.string().trim().min(1).optional(),
  fileName: z.string().min(1, 'fileName is required'),
  blobPath: z.string().min(1).optional().nullable(),
  contentType: z.string().min(1).optional().nullable(),
  sizeBytes: z.number().int().nonnegative().optional().nullable(),
});

export type ContractFile = {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  fileName: string;
  blobPath: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
};

export type InsertContractFileInput = z.infer<typeof insertContractFileSchema>;

export async function insertContractFile(input: InsertContractFileInput): Promise<ContractFile> {
  const data = insertContractFileSchema.parse(input);
  const title = data.title ?? 'Untitled Contract';

  const { rows } = await sql<ContractFile>`
    insert into contract_files (
      user_id,
      project_id,
      title,
      file_name,
      blob_path,
      content_type,
      size_bytes
    )
    values (
      ${data.userId},
      ${data.projectId ?? null},
      ${title},
      ${data.fileName},
      ${data.blobPath ?? null},
      ${data.contentType ?? null},
      ${data.sizeBytes ?? null}
    )
    returning
      id,
      user_id as "userId",
      project_id as "projectId",
      title,
      file_name as "fileName",
      blob_path as "blobPath",
      content_type as "contentType",
      size_bytes as "sizeBytes",
      created_at as "createdAt",
      updated_at as "updatedAt";
  `;

  if (!rows[0]) {
    throw new Error('Insert failed to return a contract row.');
  }

  return rows[0];
}

export async function getContractFilesByUserId(userId: string): Promise<ContractFile[]> {
  const normalizedUserId = userIdSchema.parse(userId);

  const { rows } = await sql<ContractFile>`
    select
      id,
      user_id as "userId",
      project_id as "projectId",
      title,
      file_name as "fileName",
      blob_path as "blobPath",
      content_type as "contentType",
      size_bytes as "sizeBytes",
      created_at as "createdAt",
      updated_at as "updatedAt"
    from contract_files
    where user_id = ${normalizedUserId}
    order by created_at desc;
  `;

  return rows;
}
