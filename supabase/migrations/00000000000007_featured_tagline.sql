-- One line of merchandising copy for featured extensions, so swapping what the
-- home page features is a data change rather than a deploy.
alter table public.tlds add column featured_tagline text;

update public.tlds t set featured_tagline = v.tagline
  from (values
    ('com',    'The one everybody types first'),
    ('net',    'The classic alternative when .com is taken'),
    ('org',    'For non-profits, communities and causes'),
    ('africa', 'Built for brands with a continental reach'),
    ('co',     'Short, memorable and startup-friendly'),
    ('app',    'For products people download and use')
  ) as v(name, tagline)
 where t.name = v.name;
