// Test values only — never a real key (N12, for email: no test calls real SES).
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
process.env.SUPABASE_SECRET_KEY = 'sb_test'
process.env.MAIL_SES_SENDER_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
process.env.MAIL_SES_SENDER_SECRET_ACCESS_KEY = 'test secret, not a real key'
process.env.LOG_LEVEL = 'silent'
