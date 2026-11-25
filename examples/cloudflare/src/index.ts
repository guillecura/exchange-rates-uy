import { cambistaWorker } from "cambista/worker";

// The whole server. Options: a title, the schedule, the first currencies and pairs (see the README).
export default cambistaWorker({ page: { title: "Exchange rates" } });
