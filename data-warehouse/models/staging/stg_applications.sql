-- Applications, dropping the encrypted PII columns. The warehouse must
-- never expose decrypted PII; for any flow that needs decrypted PII,
-- read directly from the operational API (with the proper auth + audit
-- + decryption boundary). The warehouse stores only the hashed lookup
-- columns + non-PII enrichment.

select
  id                      as application_id,
  partner_id,
  external_application_id,
  consumer_email_hash,     -- HMAC for joining; safe in warehouse
  consumer_phone_hash,
  credit_score,
  available_credit,
  noted_annual_income,
  bank_statements_provided,
  merchant_preapproval,
  merchant_preapproval_amount,
  consumer_preapproval,
  consumer_preapproval_amount,
  funding_estimate,
  propensity_score,
  open_lines_of_credit,
  status,
  submitted_at,
  created_at,
  updated_at
from {{ source('platform', 'applications') }}
