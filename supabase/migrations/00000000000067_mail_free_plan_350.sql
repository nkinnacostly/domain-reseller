-- MyDomainsHub Mail: the Free plan sends 350 emails a day, 10,500 a month
-- (owner, 8 Oct 2026: just above Brevo's free 300 a day), down from the 500
-- and 15,000 of migration 66. The sandbox and its review are unchanged.

update mail.plans
   set daily_cap = 350, monthly_cap = 10500, updated_at = now()
 where code = 'free';
