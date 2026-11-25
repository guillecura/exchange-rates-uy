// node server.ts  (Node 22.18+ runs TypeScript as it is)
import { serve } from "exchange-rates-uy/node";

await serve({
  port: Number(process.env.PORT ?? 8787),
  database: process.env.RATES_DATABASE ?? "./rates.db",
  adminToken: process.env.ADMIN_TOKEN,
  schedule: {
    timeZone: "America/Montevideo",
    official: { hours: [10, 14, 18], weekdays: [1, 2, 3, 4, 5] },
    market: { hours: [9, 13, 17, 21], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  },
});
