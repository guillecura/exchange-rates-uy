/**
 * The office is in Montevideo and so is the rate: what "today" means here is the
 * BCU's day and not the server's. The same trick the birthday notice uses.
 */
export function montevideoNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Montevideo" }) + " UTC");
}

/** A day as both sources write it. */
export function stamp(when: Date): string {
  return when.toISOString().slice(0, 10);
}
