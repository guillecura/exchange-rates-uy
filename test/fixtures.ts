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

/** The past dataset's answer for a day (fawazahmed0's exchange-api): lower-case codes, crypto tokens among them. */
export const pastAnswer = (day: string, rates: Record<string, number>) => ({
  date: day,
  usd: { usd: 1, btc: 0.00001, "1inch": 2.6, ...Object.fromEntries(Object.entries(rates).map(([k, v]) => [k.toLowerCase(), v])) },
});

/**
 * Replaces `fetch` for the test: the BCU's SOAP, the market's JSON, and the past dataset's day (404 unless `past`
 * answers it), each from a function.
 */
export function fakeFetch(bcu: (body: string) => string, market: () => unknown, past: (day: string) => unknown = () => null): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("bcu.gub.uy")) return new Response(bcu(String(init?.body ?? "")), { headers: { "Content-Type": "text/xml" } });
    if (url.includes("er-api.com")) return Response.json(market());
    const day = /currency-api@(\d{4}-\d{2}-\d{2})|\/\/(\d{4}-\d{2}-\d{2})\.currency-api/.exec(url);
    if (day) {
      const body = past(day[1] ?? day[2]!);
      return body ? Response.json(body) : new Response("not found", { status: 404 });
    }
    return real(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}
