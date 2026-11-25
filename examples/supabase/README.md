# On Supabase

1. `supabase functions deploy rates --no-verify-jwt` (the function is `functions/rates/index.ts`).
2. `supabase secrets set RATES_ADMIN_TOKEN=… RATES_CRON_SECRET=…`
3. The clock, from the SQL editor (pg_cron and pg_net on):

```sql
select cron.schedule('exchange-rates', '*/15 * * * *', $$
  select net.http_get(
    'https://<project>.supabase.co/functions/v1/rates/api/tick',
    headers := jsonb_build_object('Authorization', 'Bearer <RATES_CRON_SECRET>')
  )
$$);
```

The API is `https://<project>.supabase.co/functions/v1/rates/api/pairs` and the rest. The tables are in your
database (`rates_official`, `rates_market`, `rates_pair`…), so your own SQL can join them.
