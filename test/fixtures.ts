import { forgetArchive } from "../src/rates/market.ts";

/** The two sources as their answers look, for a fake `fetch`. */
export const dato = (moneda: number, fecha: string, tcc: number, tcv: number, arb?: number) =>
  `<datoscotizaciones.dato><Fecha>${fecha}</Fecha><Moneda>${moneda}</Moneda><Nombre>X</Nombre><CodigoISO>X</CodigoISO>` +
  `<TCC>${tcc}</TCC><TCV>${tcv}</TCV>${arb ? `<ArbAct>${arb}</ArbAct>` : ""}</datoscotizaciones.dato>`;

export const bcuAnswer = (blocks: string[]) =>
  `<SOAP-ENV:Envelope><SOAP-ENV:Body><wsbcucotizaciones.ExecuteResponse><Salida><respuestastatus><status>1</status></respuestastatus>` +
  `<datoscotizaciones>${blocks.join("")}</datoscotizaciones></Salida></wsbcucotizaciones.ExecuteResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

export const marketAnswer = (rates: Record<string, number>, at = "2026-11-24T00:02:31Z") => ({
  result: "success",
  time_last_update_unix: Date.parse(at) / 1000,
  rates: { USD: 1, ...rates },
});

/** The archive's table for a day (`data/market/YYYY-MM.json`): how many of each currency buy one dollar. */
export const pastAnswer = (_day: string, rates: Record<string, number>): Record<string, number> => ({ USD: 1, ...rates });

/**
 * Replaces `fetch` for the test: the BCU's SOAP, the market's JSON, and the archive's months (each day from `past`,
 * none unless it answers), each from a function. The archive's months read before are forgotten.
 */
export function fakeFetch(bcu: (body: string) => string, market: () => unknown, past: (day: string) => Record<string, number> | null = () => null): () => void {
  forgetArchive();
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("bcu.gub.uy")) return new Response(bcu(String(init?.body ?? "")), { headers: { "Content-Type": "text/xml" } });
    if (url.includes("er-api.com")) return Response.json(market());
    const month = /\/data\/market\/(\d{4}-\d{2})\.json$/.exec(url)?.[1];
    if (month) {
      const days: Record<string, Record<string, number>> = {};
      for (let d = 1; d <= 31; d += 1) {
        const day = `${month}-${String(d).padStart(2, "0")}`;
        const t = past(day);
        if (t) days[day] = t;
      }
      return Object.keys(days).length ? Response.json({ base: "USD", month, days }) : new Response("not found", { status: 404 });
    }
    return real(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}
