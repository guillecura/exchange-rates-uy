import Foundation

/// Exchange rates the same way in two modes, like the package's JavaScript and Kotlin clients:
///
/// - With a server, `RatesClient(baseURL:key:)` asks an exchange-rates-uy server (github.com/guillecura/exchange-rates-uy),
///   which keeps the history and the pairs: yours, or rates.whitebear.io with its key.
/// - Without one, `RatesClient(pairs:)` reads the sources itself, the BCU and ExchangeRate-API, with the same arithmetic
///   (`Direct.swift`). The market's past days need a server: the source only gives today's.
///
///     let rates = RatesClient(baseURL: URL(string: "https://your-server/api")!, key: "…")
///     let alone = RatesClient(pairs: ["USD/UYU", "EUR/UYU"])
///     let bank = try await rates.official()          // the BCU's pesos per unit, buying and selling
///     let usd = try await rates.history("USD/UYU", from: "2026-01-01")
///
/// A key in a phone app can be read out of it: it says which app is asking, it does not protect the server.
public struct RatesClient: Sendable {
    enum Mode: Sendable {
        case server(URL, key: String?)
        case direct(Direct)
    }

    let mode: Mode
    let session: URLSession

    /// On a server: its API's address (`…/api` included) and, when it asks for one, this app's key.
    public init(baseURL: URL, key: String? = nil, session: URLSession = .shared) {
        mode = .server(baseURL, key: key)
        self.session = session
    }

    /// Without a server: the pairs `pairs()` answers and any more currencies to read from the BCU.
    public init(pairs: [String] = ["USD/UYU", "EUR/UYU", "ARS/UYU", "BRL/UYU"], currencies: [String] = [], session: URLSession = .shared) {
        mode = .direct(Direct(pairs: pairs, currencies: currencies, session: session))
        self.session = session
    }

    /// The server's address, or nil without one.
    public var baseURL: URL? {
        if case .server(let url, _) = mode { return url }
        return nil
    }

    /// The bank's reading on `date` (YYYY-MM-DD, the last on or before it; today by default).
    public func official(date: String? = nil) async throws -> Official {
        if case .direct(let d) = mode { return try await d.official(date: date) }
        return try await call("official", ["date": date])
    }

    /// The market's table on `date` (without a server, only today's).
    public func market(date: String? = nil) async throws -> Market {
        if case .direct(let d) = mode { return try await d.market(date: date) }
        return try await call("market", ["date": date])
    }

    /// The pairs, each with both rates, on `date`.
    public func pairs(date: String? = nil) async throws -> [PairRate] {
        if case .direct(let d) = mode { return try await d.pairs(date: date) }
        let answer: PairsAnswer = try await call("pairs", ["date": date])
        return answer.pairs
    }

    /// The currencies, named in `lang`.
    public func currencies(lang: String? = nil) async throws -> [Currency] {
        if case .direct(let d) = mode { return d.currencies(lang: lang ?? "en") }
        let answer: CurrenciesAnswer = try await call("currencies", ["lang": lang])
        return answer.currencies
    }

    /// One pair (`USD/UYU`), day by day, from one source. At most ten years per call.
    public func history(_ pair: String, from: String? = nil, to: String? = nil, source: Source = .official) async throws -> [HistoryDay] {
        if case .direct(let d) = mode { return try await d.history(pair, from: from, to: to, source: source) }
        let path = "pairs/\(pair.uppercased().replacingOccurrences(of: "/", with: "-"))/history"
        let answer: HistoryAnswer = try await call(path, ["from": from, "to": to, "source": source.rawValue])
        return answer.days
    }

    /// An amount in another currency.
    public func convert(_ amount: Double, from: String, to: String, date: String? = nil, source: Source = .market, side: Side? = nil) async throws -> Conversion {
        if case .direct(let d) = mode { return try await d.convert(amount, from: from, to: to, date: date, source: source, side: side ?? .sell) }
        return try await call("convert", [
            "amount": String(amount), "from": from, "to": to, "date": date, "source": source.rawValue, "side": side?.rawValue,
        ])
    }

    func call<T: Decodable>(_ path: String, _ query: [String: String?]) async throws -> T {
        guard case .server(let baseURL, let key) = mode else { throw RatesError(status: 0, message: "no server") }
        var parts = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }.sorted { $0.name < $1.name }
        parts.queryItems = items.isEmpty ? nil : items
        var request = URLRequest(url: parts.url!)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let key { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw RatesError(status: status, message: (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "HTTP \(status)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private struct PairsAnswer: Decodable { let pairs: [PairRate] }
private struct CurrenciesAnswer: Decodable { let currencies: [Currency] }
private struct HistoryAnswer: Decodable { let days: [HistoryDay] }

/// The server's answer when it refuses: `{ "error": "…" }`.
private struct Failure: Decodable {
    let error: String
}
