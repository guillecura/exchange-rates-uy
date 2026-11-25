package uy.exchangerates

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.coroutines.runBlocking

/** A local server answering with the API's real shapes, so the client is tested over HTTP. */
class RatesClientTest {
    private lateinit var server: HttpServer
    private var lastPath = ""
    private var lastAuth: String? = null
    private var answer: Pair<Int, String> = 404 to "{}"

    @BeforeTest fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            lastPath = ex.requestURI.toString()
            lastAuth = ex.requestHeaders.getFirst("Authorization")
            val bytes = answer.second.toByteArray()
            ex.responseHeaders.add("Content-Type", "application/json")
            ex.sendResponseHeaders(answer.first, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    @AfterTest fun stop() = server.stop(0)

    private fun client(key: String? = "app-key") = RatesClient("http://127.0.0.1:${server.address.port}/api/", key)

    @Test fun officialWithTheKey() = runBlocking {
        answer = 200 to """{"date":"2026-11-25","day":"2026-11-24","perLocal":{"UYU":{"buy":1,"sell":1},"USD":{"buy":39.5,"sell":41.9}},"published":{},"quote":"UYU","source":"https://www.bcu.gub.uy"}"""
        val bank = client().official("2026-11-25")
        assertEquals("/api/official?date=2026-11-25", lastPath)
        assertEquals("Bearer app-key", lastAuth)
        assertEquals(Spread(39.5, 41.9), bank.perLocal["USD"])
    }

    @Test fun marketAndPesosPerUnit() = runBlocking {
        answer = 200 to """{"date":"2026-11-25","day":"2026-11-24","perUsd":{"USD":1,"UYU":40.5,"EUR":0.81},"base":"USD","credit":{"label":"Rates By Exchange Rate API","href":"https://www.exchangerate-api.com"}}"""
        val market = client().market()
        assertEquals(40.5, market.perLocal()["USD"])
        assertEquals(50.0, market.perLocal()["EUR"]!!, 1e-9)
    }

    @Test fun historyPath() = runBlocking {
        answer = 200 to """{"pair":"USD/UYU","source":"official","from":"2026-11-01","to":"2026-11-30","days":[{"day":"2026-11-24","buy":39.5,"sell":41.9}]}"""
        val days = client().history("usd/uyu", from = "2026-11-01")
        assertEquals("/api/pairs/USD-UYU/history?from=2026-11-01&source=official", lastPath)
        assertEquals(listOf("2026-11-24"), days.map { it.day })
    }

    @Test fun theServersErrors() {
        answer = 403 to """{"error":"this API is for its allowed sites and keys"}"""
        val e = assertFailsWith<RatesException> { runBlocking { client(key = null).pairs() } }
        assertEquals(403, e.status)
        assertEquals("this API is for its allowed sites and keys", e.message)
    }

    private fun sources() {
        server.removeContext("/")
        server.createContext("/") { ex ->
            val path = ex.requestURI.path
            val body = if (path.startsWith("/archive/")) {
                val month = path.removePrefix("/archive/")
                val days = (1..28).joinToString(",") { "\"$month-%02d\":{\"UYU\":40,\"EUR\":0.9}".format(it) }
                """{"base":"USD","month":"$month","days":{$days}}"""
            } else if (path.startsWith("/bcu")) {
                "<Envelope><status>1</status>" +
                    "<datoscotizaciones.dato><Fecha>2026-11-24</Fecha><Moneda>2225</Moneda><TCC>39.5</TCC><TCV>41.9</TCV></datoscotizaciones.dato>" +
                    "<datoscotizaciones.dato><Fecha>2026-11-24</Fecha><Moneda>1111</Moneda><TCC>44</TCC><TCV>47</TCV><ArbAct>1.16</ArbAct></datoscotizaciones.dato></Envelope>"
            } else {
                """{"result":"success","time_last_update_unix":1795478551,"rates":{"USD":1,"UYU":40.5,"EUR":0.86,"JPY":155}}"""
            }
            val bytes = body.toByteArray()
            ex.sendResponseHeaders(200, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
    }

    private fun direct(): RatesClient {
        val root = "http://127.0.0.1:${server.address.port}"
        return RatesClient.direct(Direct(listOf("USD/UYU", "EUR/USD"), emptyList(), 15_000, "$root/bcu", "$root/market", { listOf("$root/archive/$it") }))
    }

    @Test fun directOfficialAndPairs() = runBlocking {
        sources()
        val rates = direct()
        assertEquals(null, rates.baseUrl)
        val bank = rates.official("2026-11-25")
        assertEquals("2026-11-24", bank.day)
        assertEquals(Spread(39.5, 41.9), bank.perLocal["USD"])
        val pairs = rates.pairs()
        assertEquals(listOf("USD/UYU", "EUR/USD"), pairs.map { it.pair })
        assertEquals(1.16, pairs[1].official?.buy, "the bank's published EUR/USD wins")
        assertEquals(40.5, pairs[0].market?.rate)
    }

    @Test fun directConvertAndHistory() = runBlocking {
        sources()
        val rates = direct()
        assertEquals(4190.0, rates.convert(100.0, "USD", "UYU", date = "2026-11-25", source = Source.OFFICIAL).result, 1e-9)
        assertEquals(155 / 0.86, rates.convert(1.0, "EUR", "JPY").rate, 1e-9)
        assertEquals(listOf("2026-11-24"), rates.history("USD/UYU", from = "2026-11-20", to = "2026-11-25").map { it.day })
        val market = rates.history("USD/UYU", from = "2026-11-21", to = "2026-11-24", source = Source.MARKET)
        assertEquals(listOf(Triple("2026-11-21", 40.0, "past"), Triple("2026-11-22", 40.0, "past"), Triple("2026-11-23", 40.5, "live")), market.map { Triple(it.day, it.buy, it.source) })
        val past = rates.market("2026-11-22")
        assertEquals("past", past.source)
        assertEquals(1.0, past.perUsd["USD"])
        assertEquals("exchange-rates-uy", past.credit.label)
        assertEquals(404, assertFailsWith<RatesException> { rates.market("2020-01-01") }.status)
        assertEquals(listOf("USD", "UYU", "EUR"), rates.currencies("es").map { it.iso })
    }
}
