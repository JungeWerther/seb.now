-- Gives one read back to a user's allowance and returns what's left after it,
-- or null when they have no row. One statement, so concurrent refunds each
-- take one off under the row lock and `used` never goes below 0.
--
-- Unlike spend_query_credit it takes the user rather than reading auth.uid(),
-- and only service_role may run it: a reader who could call it would refund
-- themselves without limit.
create function public.refund_query_credit(target uuid)
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  update query_credits
  set used = greatest(used - 1, 0)
  where user_id = target
  returning query_credit_limit() - used
$$;

revoke execute on function public.refund_query_credit(uuid) from public, anon, authenticated;
grant execute on function public.refund_query_credit(uuid) to service_role;
