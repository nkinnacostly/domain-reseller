-- Live market feeds used for the naira/dollar rate.
-- 'official' is retired in favour of the named feeds it actually came from.
alter type public.fx_source add value if not exists 'er-api';
alter type public.fx_source add value if not exists 'currency-api';
