// Test values only — never a real key. The relay holds no SES key at all.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
process.env.SUPABASE_SECRET_KEY = 'sb_test'
process.env.MAIL_API_KEY_PEPPER = 'test pepper, not a secret, 0123456789'
process.env.LOG_LEVEL = 'silent'
