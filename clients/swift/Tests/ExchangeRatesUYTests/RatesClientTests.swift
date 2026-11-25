import XCTest
@testable import ExchangeRatesUY

/// Answers every request from a function, so the client is tested against the server's real shapes.
final class Stub: URLProtocol {
    nonisolated(unsafe) static var answer: (URLRequest) -> (Int, String) = { _ in (404, "{}") }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body) = Stub.answer(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class RatesClientTests: XCTestCase {
    func client(key: String? = "app-key") -> RatesClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Stub.self]
        return RatesClient(baseURL: URL(string: "https://rates.example/api")!, key: key, session: URLSession(configuration: config))
    }

    func testOfficialWithTheKey() async throws {
        Stub.answer = { req in
            XCTAssertEqual(req.url?.absoluteString, "https://rates.example/api/official?date=2026-11-25")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer app-key")
            return (200, #"{"date":"2026-11-25","day":"2026-11-24","perLocal":{"UYU":{"buy":1,"sell":1},"USD":{"buy":39.5,"sell":41.9}},"published":{},"quote":"UYU","source":"https://www.bcu.gub.uy"}"#)
        }
        let bank = try await client().official(date: "2026-11-25")
        XCTAssertEqual(bank.perLocal["USD"], Spread(buy: 39.5, sell: 41.9))
    }

    func testMarketAndPesosPerUnit() async throws {
        Stub.answer = { _ in (200, #"{"date":"2026-11-25","day":"2026-11-24","perUsd":{"USD":1,"UYU":40.5,"EUR":0.81},"base":"USD","credit":{"label":"Rates By Exchange Rate API","href":"https://www.exchangerate-api.com"}}"#) }
        let market = try await client().market()
        XCTAssertEqual(market.perLocal()["USD"], 40.5)
        XCTAssertEqual(market.perLocal()["EUR"]!, 50, accuracy: 1e-9)
        XCTAssertEqual(market.credit.label, "Rates By Exchange Rate API")
    }

    func testHistoryPath() async throws {
        Stub.answer = { req in
            XCTAssertEqual(req.url?.path, "/api/pairs/USD-UYU/history")
            return (200, #"{"days":[{"day":"2026-11-24","buy":39.5,"sell":41.9}]}"#)
        }
        let days = try await client().history("usd/uyu", from: "2026-11-01")
        XCTAssertEqual(days.map(\.day), ["2026-11-24"])
    }

    func testTheServersErrors() async {
        Stub.answer = { _ in (403, #"{"error":"this API is for its allowed sites and keys"}"#) }
        do {
            _ = try await client(key: nil).pairs()
            XCTFail("a 403 throws")
        } catch let e as RatesError {
            XCTAssertEqual(e.status, 403)
            XCTAssertEqual(e.message, "this API is for its allowed sites and keys")
        } catch {
            XCTFail("\(error)")
        }
    }

    func direct() -> RatesClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Stub.self]
        return RatesClient(pairs: ["USD/UYU", "EUR/USD"], session: URLSession(configuration: config))
    }

    static let bcu = """
    <Envelope><status>1</status>\
    <datoscotizaciones.dato><Fecha>2026-11-24</Fecha><Moneda>2225</Moneda><TCC>39.5</TCC><TCV>41.9</TCV></datoscotizaciones.dato>\
    <datoscotizaciones.dato><Fecha>2026-11-24</Fecha><Moneda>1111</Moneda><TCC>44</TCC><TCV>47</TCV><ArbAct>1.16</ArbAct></datoscotizaciones.dato></Envelope>
    """

    func sources() {
        Stub.answer = { req in
            if req.url?.host == "cotizaciones.bcu.gub.uy" { return (200, RatesClientTests.bcu) }
            if let url = req.url?.absoluteString, let r = url.range(of: #"/data/market/\d{4}-\d{2}\.json$"#, options: .regularExpression) {
                let month = String(url[r].dropFirst("/data/market/".count).prefix(7))
                let days = (1...28).map { #""\#(month)-\#(String(format: "%02d", $0))":{"UYU":40,"EUR":0.9}"# }.joined(separator: ",")
                return month >= "2024-03" ? (200, #"{"base":"USD","month":"\#(month)","days":{\#(days)}}"#) : (404, "{}")
            }
            return (200, #"{"result":"success","time_last_update_unix":1795478551,"rates":{"USD":1,"UYU":40.5,"EUR":0.86,"JPY":155}}"#)
        }
    }

    func testDirectOfficialAndPairs() async throws {
        sources()
        let rates = direct()
        XCTAssertNil(rates.baseURL)
        let bank = try await rates.official(date: "2026-11-25")
        XCTAssertEqual(bank.day, "2026-11-24")
        XCTAssertEqual(bank.perLocal["USD"], Spread(buy: 39.5, sell: 41.9))
        let pairs = try await rates.pairs()
        XCTAssertEqual(pairs.map(\.pair), ["USD/UYU", "EUR/USD"])
        XCTAssertEqual(pairs[1].official?.buy, 1.16, "the bank's published EUR/USD wins")
        XCTAssertEqual(pairs[0].market?.rate, 40.5)
    }

    func testDirectConvertAndHistory() async throws {
        sources()
        let rates = direct()
        let official = try await rates.convert(100, from: "USD", to: "UYU", date: "2026-11-25", source: .official)
        XCTAssertEqual(official.result, 4190, accuracy: 1e-9)
        let market = try await rates.convert(1, from: "EUR", to: "JPY")
        XCTAssertEqual(market.rate, 155 / 0.86, accuracy: 1e-9)
        let days = try await rates.history("USD/UYU", from: "2026-11-20", to: "2026-11-25")
        XCTAssertEqual(days.map(\.day), ["2026-11-24"])
        let marketDays = try await rates.history("USD/UYU", from: "2026-11-21", to: "2026-11-24", source: .market)
        XCTAssertEqual(marketDays.map(\.day), ["2026-11-21", "2026-11-22", "2026-11-23"])
        XCTAssertEqual(marketDays.map(\.buy), [40, 40, 40.5])
        XCTAssertEqual(marketDays.map(\.source), ["past", "past", "live"])
        let past = try await rates.market(date: "2026-11-22")
        XCTAssertEqual(past.source, "past")
        XCTAssertEqual(past.perUsd["USD"], 1)
        XCTAssertEqual(past.credit.label, "exchange-rates-uy")
        do {
            _ = try await rates.market(date: "2020-01-01")
            XCTFail("before the dataset begins")
        } catch let e as RatesError {
            XCTAssertEqual(e.status, 404)
        }
        let currencies = try await rates.currencies(lang: "es")
        XCTAssertEqual(currencies.map(\.iso), ["USD", "UYU", "EUR"])
    }
}
