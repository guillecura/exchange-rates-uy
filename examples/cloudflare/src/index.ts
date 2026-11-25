import { exchangeRatesWorker } from "exchange-rates-uy/worker";

export default exchangeRatesWorker({
  page: { title: "Exchange rates" },
  // A new database's first ones; the panel (/admin) adds the rest.
  seed: { currencies: ["USD", "UYU", "EUR", "BRL"], pairs: ["USD/UYU", "EUR/UYU", "BRL/UYU"] },
});
