package uy.exchangerates

import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Exchange rates the same way in two modes, like the package's JavaScript and Swift clients:
 *
 * - With a server, `RatesClient(baseUrl, key)` asks an exchange-rates-uy server (github.com/guillecura/exchange-rates-uy),
 *   which keeps the history and the pairs: yours, or rates.whitebear.io with its key.
 * - Without one, `RatesClient.direct(pairs)` reads the sources itself, the BCU and ExchangeRate-API, with the same
 *   arithmetic ([Direct]). The market's past days need a server: the source only gives today's.
 *
 *     val rates = RatesClient("https://your-server/api", key = "…")
 *     val alone = RatesClient.direct(listOf("USD/UYU", "EUR/UYU"))
 *     val bank = rates.official()                  // the BCU's pesos per unit, buying and selling
 *     val usd = rates.history("USD/UYU", from = "2026-01-01")
 *
 * Every call suspends and runs on [Dispatchers.IO]. A key in a phone app can be read out of it: it says which app is
 * asking, it does not protect the server.
 */
class RatesClient private constructor(
    private val base: String?,
    private val key: String?,
    private val timeoutMillis: Int,
    private val direct: Direct?,
) {
    /** On a server: its API's address (`…/api` included) and, when it asks for one, this app's key. */
    constructor(baseUrl: String, key: String? = null, timeoutMillis: Int = 15_000) :
        this(baseUrl.trimEnd('/'), key, timeoutMillis, null)

    companion object {
        /** Without a server: the pairs [pairs] answers and any more currencies to read from the BCU. */
        fun direct(
            pairs: List<String> = listOf("USD/UYU", "EUR/UYU", "ARS/UYU", "BRL/UYU"),
            currencies: List<String> = emptyList(),
            timeoutMillis: Int = 15_000,
        ): RatesClient = RatesClient(null, null, timeoutMillis, Direct(pairs, currencies, timeoutMillis))

        internal fun direct(d: Direct): RatesClient = RatesClient(null, null, 15_000, d)
    }

    /** The server's address, or null without one. */
    val baseUrl: String? get() = base

    private val json = Json { ignoreUnknownKeys = true }

    /** The bank's reading on [date] (YYYY-MM-DD, the last on or before it; today by default). */
    suspend fun official(date: String? = null): Official = io {
        direct?.official(date) ?: call("official", mapOf("date" to date))
    }

    /** The market's table on [date] (without a server, only today's). */
    suspend fun market(date: String? = null): Market = io {
        direct?.market(date) ?: call("market", mapOf("date" to date))
    }

    /** The pairs, each with both rates, on [date]. */
    suspend fun pairs(date: String? = null): List<PairRate> = io {
        direct?.pairs(date) ?: call<PairsAnswer>("pairs", mapOf("date" to date)).pairs
    }

    /** The currencies, named in [lang]. */
    suspend fun currencies(lang: String? = null): List<Currency> = io {
        direct?.currencies(lang ?: "en") ?: call<CurrenciesAnswer>("currencies", mapOf("lang" to lang)).currencies
    }

    /** One pair (`USD/UYU`), day by day, from one source. At most ten years per call. */
    suspend fun history(pair: String, from: String? = null, to: String? = null, source: Source = Source.OFFICIAL): List<HistoryDay> = io {
        direct?.history(pair, from, to, source) ?: call<HistoryAnswer>(
            "pairs/${pair.uppercase().replace("/", "-")}/history",
            mapOf("from" to from, "to" to to, "source" to source.wire),
        ).days
    }

    /** An amount in another currency. */
    suspend fun convert(
        amount: Double,
        from: String,
        to: String,
        date: String? = null,
        source: Source = Source.MARKET,
        side: Side? = null,
    ): Conversion = io {
        direct?.convert(amount, from, to, date, source, side ?: Side.SELL) ?: call(
            "convert",
            mapOf("amount" to amount.toString(), "from" to from, "to" to to, "date" to date, "source" to source.wire, "side" to side?.wire),
        )
    }

    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    private inline fun <reified T> call(path: String, query: Map<String, String?>): T {
        val q = query.filterValues { it != null }.entries.sortedBy { it.key }
            .joinToString("&") { "${it.key}=${URLEncoder.encode(it.value, Charsets.UTF_8)}" }
        val (status, body) = http(
            "$base/$path${if (q.isEmpty()) "" else "?$q"}",
            timeoutMillis,
            buildMap {
                put("Accept", "application/json")
                key?.let { put("Authorization", "Bearer $it") }
            },
        )
        if (status !in 200..299) {
            val said = runCatching { json.decodeFromString<Failure>(body).error }.getOrNull()
            throw RatesException(status, said ?: "HTTP $status")
        }
        return json.decodeFromString<T>(body)
    }

    @Serializable private data class PairsAnswer(val pairs: List<PairRate>)
    @Serializable private data class CurrenciesAnswer(val currencies: List<Currency>)
    @Serializable private data class HistoryAnswer(val days: List<HistoryDay>)
    @Serializable private data class Failure(val error: String)
}
