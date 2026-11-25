import { serve } from "cambista/node";

serve({
  port: Number(process.env.PORT ?? 8787),
  database: process.env.CAMBISTA_DATABASE ?? "./cambista.db",
  adminToken: process.env.ADMIN_TOKEN,
  page: { title: "Exchange rates" },
});
