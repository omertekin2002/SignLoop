-- Reuse the existing owner-scoped file lifecycle for visual message inputs.
ALTER TABLE chat_files DROP CONSTRAINT chat_files_media_type_check;
ALTER TABLE chat_files DROP CONSTRAINT chat_files_text_content_check;
ALTER TABLE chat_files ADD CONSTRAINT chat_files_media_type_check CHECK (
  media_type IN ('application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg', 'image/webp')
);
ALTER TABLE chat_files ADD CONSTRAINT chat_files_content_check CHECK (
  (media_type LIKE 'image/%' AND text_content = '' AND octet_length(file_data) <= 393216)
  OR (media_type NOT LIKE 'image/%' AND char_length(text_content) BETWEEN 1 AND 200000)
);
