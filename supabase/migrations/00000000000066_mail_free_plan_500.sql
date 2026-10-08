-- MyDomainsHub Mail: the Free plan sends 500 emails a day, 15,000 a month
-- (owner, 8 Oct 2026: a reason to switch before marketing starts), up from
-- 100 a day and 3,000 a month. The sandbox (100 a day, to members only) and
-- the review before it is left are unchanged, so a new account still cannot
-- send to strangers until a person has looked at it; and the quota watch
-- still holds back free and sandbox sending first when the shared SES quota
-- runs high (§4.4).

update mail.plans
   set daily_cap = 500, monthly_cap = 15000, updated_at = now()
 where code = 'free';
