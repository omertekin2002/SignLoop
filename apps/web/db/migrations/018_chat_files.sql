CREATE TABLE chat_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  filename text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  file_data bytea NOT NULL CHECK (octet_length(file_data) BETWEEN 1 AND 4194304),
  text_content text NOT NULL CHECK (char_length(text_content) BETWEEN 1 AND 200000),
  warning text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_files_thread_idx ON chat_files(thread_id);
