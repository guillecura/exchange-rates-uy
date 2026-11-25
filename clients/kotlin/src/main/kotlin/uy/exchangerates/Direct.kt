package uy.exchangerates

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The client without a server: the same calls, answered by reading the sources directly, with the same arithmetic as
 * the server and the JavaScript client (src/rates in the package): the BCU's SOAP service, one day or a range at a
 * time, and ExchangeRate-API's table. The market's past days need a server: the source only gives today's. Blocking:
 * [RatesClient] runs it on IO.
 */
internal class Direct(
    pairs: List<String>,
    currencies: List<String>,
    private val timeoutMillis: Int,
    private val bcuUrl: String = BCU_URL,
    private val marketUrl: String = MARKET_URL,
) {
    private val pairs = pairs.mapNotNull { sides(it) }
    private val isos = (this.pairs.flatMap { listOf(it.first, it.second) } + currencies.map { it.uppercase() }).distinct()
    private val json = Json { ignoreUnknownKeys = true }

    companion object {
        /** The numbers the BCU calls each currency by (its `awsbcumonedas` list), as the package has them. */
        val BCU_CODES = mapOf(
            "XDR" to 2, "AUD" to 105, "ARS" to 500, "BRL" to 1000, "EUR" to 1111, "CLP" to 1300, "NZD" to 1490, "ZAR" to 1620,
            "DKK" to 1800, "USD" to 2225, "CAD" to 2309, "GBP" to 2700, "JPY" to 3600, "PEN" to 4000, "CNY" to 4150,
            "CNH" to 4155, "MXN" to 4200, "HUF" to 4300, "TRY" to 4400, "NOK" to 4600, "PYG" to 4800, "ISK" to 4900,
            "HKD" to 5100, "KRW" to 5300, "RUB" to 5400, "COP" to 5500, "MYR" to 5600, "INR" to 5700, "SEK" to 5800,
            "CHF" to 5900, "VES" to 6200,
        )
        const val BCU_URL = "https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotizaciones"
        const val BCU_PAGE = "https://www.bcu.gub.uy/Estadisticas-e-Indicadores/Paginas/Cotizaciones.aspx"
        const val MARKET_URL = "https://open.er-api.com/v6/latest/USD"
        val CREDIT = Credit("Rates By Exchange Rate API", "https://www.exchangerate-api.com")
        private val MONTEVIDEO: ZoneId = ZoneId.of("America/Montevideo")
        private val DAY = Regex("""^\d{4}-\d{2}-\d{2}$""")
        private const val PAST = "the market's past days need a server: the source only gives today's"

        fun today(): String = LocalDate.now(MONTEVIDEO).toString()
        fun shift(day: String, days: Long): String = LocalDate.parse(day).plusDays(days).toString()
        fun checked(day: String?): String? {
            if (day != null && !DAY.matches(day)) throw RatesException(400, "a day is YYYY-MM-DD: $day")
            return day
        }
        fun sides(pair: String): Pair<String, String>? = pair.uppercase().split('/', '-').takeIf { it.size == 2 }?.let { it[0] to it[1] }

        // The arithmetic (the package's officialCross and marketCross)
        fun officialCross(perLocal: Map<String, Spread>, published: Map<String, Spread>, base: String, quote: String): Spread? {
            published["$base/$quote"]?.let { return it }
            val from = perLocal[base] ?: return null
            val to = perLocal[quote] ?: return null
            val buy = from.buy / to.sell
            return if (buy.isFinite() && buy > 0) Spread(buy, from.sell / to.buy) else null
        }

        fun marketCross(perUsd: Map<String, Double>, base: String, quote: String): Double? {
            val from = perUsd[base]?.takeIf { it > 0 } ?: return null
            val to = perUsd[quote]?.takeIf { it > 0 } ?: return null
            return to / from
        }

        private fun tag(xml: String, name: String): String? =
            Regex("<$name>([^<]*)</$name>").find(xml)?.groupValues?.get(1)?.trim()

        /** Each currency's block under its own day; the arbitrage it publishes against the dollar kept apart. */
        fun parseBcu(xml: String): List<Reading> {
            if (tag(xml, "status") != "1") return emptyList()
            val byCode = BCU_CODES.entries.associate { (iso, code) -> code to iso }
            val byDay = sortedMapOf<String, Reading>()
            for (block in xml.split("<datoscotizaciones.dato").drop(1)) {
                val day = tag(block, "Fecha") ?: continue
                val iso = tag(block, "Moneda")?.toIntOrNull()?.let { byCode[it] } ?: continue
                val buy = tag(block, "TCC")?.toDoubleOrNull()?.takeIf { it > 0 } ?: continue
                val sell = tag(block, "TCV")?.toDoubleOrNull() ?: continue
                val r = byDay.getOrPut(day) { Reading(day, mutableMapOf("UYU" to Spread(1.0, 1.0)), mutableMapOf()) }
                r.perLocal[iso] = Spread(buy, sell)
                tag(block, "ArbAct")?.toDoubleOrNull()?.takeIf { it > 0 }?.let { r.published["$iso/USD"] = Spread(it, it) }
            }
            return byDay.values.toList()
        }
    }

    class Reading(val day: String, val perLocal: MutableMap<String, Spread>, val published: MutableMap<String, Spread>)

    @Serializable private data class Table(val result: String? = null, val time_last_update_unix: Long? = null, val rates: Map<String, Double>? = null)

    // The sources

    fun bcuBetween(from: String, to: String, wanted: List<String>): List<Reading> {
        val codes = wanted.mapNotNull { BCU_CODES[it] }
        if (codes.isEmpty()) return emptyList()
        val envelope = """<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cot="Cotiza"><soapenv:Body><cot:wsbcucotizaciones.Execute><cot:Entrada><cot:Moneda>""" +
            codes.joinToString("") { "<cot:item>$it</cot:item>" } +
            "</cot:Moneda><cot:FechaDesde>$from</cot:FechaDesde><cot:FechaHasta>$to</cot:FechaHasta><cot:Grupo>0</cot:Grupo></cot:Entrada></cot:wsbcucotizaciones.Execute></soapenv:Body></soapenv:Envelope>"
        val (status, body) = http(bcuUrl, timeoutMillis, mapOf("Content-Type" to "text/xml;charset=UTF-8", "SOAPAction" to "\"\""), "POST", envelope)
        return if (status == 200) parseBcu(body) else emptyList()
    }

    /** The bank's last reading on or before [day], walking back a week at most (weekends, bank holidays). */
    fun reading(day: String): Reading {
        for (back in 0L until 7L) {
            val d = shift(day, -back)
            runCatching { bcuBetween(d, d, isos).lastOrNull() }.getOrNull()?.let { return it }
        }
        throw RatesException(502, "the BCU published nothing in the week before that day")
    }

    fun table(): Pair<String, Map<String, Double>> {
        val (status, body) = http(marketUrl, timeoutMillis)
        val t = runCatching { json.decodeFromString<Table>(body) }.getOrNull()
        val rates = t?.rates
        if (status != 200 || t?.result != "success" || rates == null) throw RatesException(502, "ExchangeRate-API answered no table")
        val at = t.time_last_update_unix?.let { Instant.ofEpochSecond(it) } ?: Instant.now()
        return LocalDate.ofInstant(at, MONTEVIDEO).toString() to (rates + ("USD" to 1.0))
    }

    // The calls

    fun official(date: String?): Official {
        val asked = checked(date) ?: today()
        val r = reading(asked)
        return Official(asked, r.day, r.perLocal.toMap(), r.published.toMap(), "UYU", BCU_PAGE)
    }

    fun market(date: String?): Market {
        val asked = checked(date) ?: today()
        val (day, perUsd) = table()
        if (date != null && asked != today() && asked < day) throw RatesException(400, PAST)
        return Market(asked, day, perUsd, "USD", CREDIT)
    }

    fun pairs(date: String?): List<PairRate> {
        val bank = runCatching { official(date) }.getOrNull()
        val table = runCatching { market(date) }.getOrNull()
        return pairs.map { (base, quote) ->
            val s = bank?.let { officialCross(it.perLocal, it.published, base, quote) }
            val rate = table?.let { marketCross(it.perUsd, base, quote) }
            PairRate(
                "$base/$quote", base, quote, true,
                if (s != null && bank != null) OfficialRate(bank.day, s.buy, s.sell) else null,
                if (rate != null && table != null) MarketRate(table.day, rate) else null,
            )
        }
    }

    fun currencies(lang: String): List<Currency> {
        val locale = Locale.forLanguageTag(lang)
        return isos.map { iso ->
            val c = runCatching { java.util.Currency.getInstance(iso) }.getOrNull()
            Currency(
                iso,
                c?.getDisplayName(locale) ?: iso,
                c?.getSymbol(Locale.US) ?: iso,
                c?.defaultFractionDigits?.takeIf { it >= 0 } ?: 2,
                iso == "UYU" || iso in BCU_CODES,
            )
        }
    }

    fun history(pair: String, from: String?, to: String?, source: Source): List<HistoryDay> {
        val (base, quote) = sides(pair) ?: throw RatesException(400, "a pair is BASE/QUOTE")
        if (source == Source.MARKET) throw RatesException(400, PAST)
        val end = checked(to) ?: today()
        val start = checked(from) ?: shift(end, -30)
        val byDay = sortedMapOf<String, Reading>()
        // One currency and one year at a time: the bank refuses wider ranges.
        var a = start
        while (a <= end) {
            val b = minOf(shift(a, 364), end)
            for (iso in listOf(base, quote).filter { it in BCU_CODES }) {
                for (r in bcuBetween(a, b, listOf(iso))) {
                    val had = byDay.getOrPut(r.day) { Reading(r.day, mutableMapOf(), mutableMapOf()) }
                    had.perLocal.putAll(r.perLocal)
                    had.published.putAll(r.published)
                }
            }
            a = shift(b, 1)
        }
        return byDay.values.mapNotNull { r -> officialCross(r.perLocal, r.published, base, quote)?.let { HistoryDay(r.day, it.buy, it.sell) } }
    }

    fun convert(amount: Double, from: String, to: String, date: String?, source: Source, side: Side): Conversion {
        val f = from.uppercase()
        val t = to.uppercase()
        if (source == Source.OFFICIAL) {
            val o = official(date)
            val s = officialCross(o.perLocal, o.published, f, t) ?: throw RatesException(404, "no official rate for $f/$t")
            val rate = when (side) { Side.MID -> (s.buy + s.sell) / 2; Side.BUY -> s.buy; Side.SELL -> s.sell }
            return Conversion(amount, f, t, o.date, o.day, "official", side.wire, rate, amount * rate)
        }
        val m = market(date)
        val rate = marketCross(m.perUsd, f, t) ?: throw RatesException(404, "no market rate for $f/$t")
        return Conversion(amount, f, t, m.date, m.day, "market", null, rate, amount * rate)
    }
}
