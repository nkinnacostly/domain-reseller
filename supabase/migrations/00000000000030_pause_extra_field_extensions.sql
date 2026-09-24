-- Extensions whose registries want registrant details our checkout does not
-- collect (tlds.requires_extra_fields, from the supplier catalogue): Turkey
-- (.tr, .com.tr), the United States' nexus rules (.us), Hong Kong (.hk),
-- Kazakhstan (.kz) and Portugal (.pt). A customer could pay, have the
-- registration refused, and be refunded — so they are off sale until checkout
-- asks for those details. The catalogue sync never touches `is_paused`.

update public.tlds
   set is_paused = true,
       paused_reason = 'The registry needs registrant details our checkout does not collect yet (requires_extra_fields).'
 where name in ('tr', 'com.tr', 'us', 'hk', 'kz', 'pt')
   and not is_paused;
