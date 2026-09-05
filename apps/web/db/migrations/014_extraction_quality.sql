alter table contracts add column extraction_warning text;
alter table context_documents add column extraction_warning text;
-- Recover warnings from stored file metadata for existing contracts.
update contracts c set extraction_warning = case
  when latest.extraction_method = 'pdf_scanned' then 'This PDF has an incomplete text layer. Verify the source before relying on the analysis.'
  when latest.extraction_method = 'tesseract_ocr' and latest.extraction_confidence < 60 then 'OCR confidence is low. Verify the source before relying on the analysis.'
  else null end
from (select distinct on (contract_id) contract_id, extraction_method, extraction_confidence
  from contract_files order by contract_id, created_at desc) latest
where latest.contract_id = c.id;
