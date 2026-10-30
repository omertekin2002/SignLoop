import { z } from "zod";

/** Each note's limit in Unicode code points, matching migration 022's char_length checks. */
export const CONTRACT_NOTE_MAX_CHARACTERS = 10_000;

export type ContractNotes = {
  acceptanceReasons: string;
  openQuestions: string;
};

const NoteSchema = z
  .string()
  .refine((value) => !value.includes("\u0000"), "Notes cannot contain NUL characters")
  .refine(
    (value) => [...value].length <= CONTRACT_NOTE_MAX_CHARACTERS,
    `Each note is at most ${CONTRACT_NOTE_MAX_CHARACTERS} characters`,
  );

// expectedUpdatedAt is the updatedAt the client last read: null when the contract had no notes yet.
const ContractNotesUpdateSchema = z.strictObject({
  acceptanceReasons: NoteSchema,
  openQuestions: NoteSchema,
  expectedUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type ContractNotesUpdate = z.infer<typeof ContractNotesUpdateSchema>;

/** Validate a `PUT /api/contracts/:id/notes` body; null when it is malformed or too long. */
export function parseContractNotesUpdate(body: unknown): ContractNotesUpdate | null {
  const parsed = ContractNotesUpdateSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
