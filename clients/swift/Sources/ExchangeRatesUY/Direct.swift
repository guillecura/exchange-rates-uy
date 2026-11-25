import Foundation

/// The client without a server: the same calls, answered by reading the sources directly, with the same arithmetic as
/// the server and the JavaScript client (src/rates in the package): the BCU's SOAP service, one day or a range at a
/// time, and ExchangeRate-API's table; the market's past days (from 2 March 2024) from the package's own archive
/// (`data/market/YYYY-MM.json`), a month per request, kept.
struct Direct: Sendable {
    let pairs: [(base: String, quote: String)]
    let isos: [String]
    let session: URLSession
    let archive = Archive()

    init(pairs: [String], currencies: [String], session: URLSession) {
        self.pairs = pairs.compactMap { Direct.sides($0) }
        var seen = Set<String>()
        isos = (self.pairs.flatMap { [$0.base, $0.quote] } + currencies.map { $0.uppercased() }).filter { seen.insert($0).inserted }
        self.session = session
    }

    // MARK: The sources

    /// The numbers the BCU calls each currency by (its `awsbcumonedas` list), as the package has them.
    static let bcuCodes: [String: Int] = [
        "XDR": 2, "AUD": 105, "ARS": 500, "BRL": 1000, "EUR": 1111, "CLP": 1300, "NZD": 1490, "ZAR": 1620, "DKK": 1800,
        "USD": 2225, "CAD": 2309, "GBP": 2700, "JPY": 3600, "PEN": 4000, "CNY": 4150, "CNH": 4155, "MXN": 4200, "HUF": 4300,
        "TRY": 4400, "NOK": 4600, "PYG": 4800, "ISK": 4900, "HKD": 5100, "KRW": 5300, "RUB": 5400, "COP": 5500, "MYR": 5600,
        "INR": 5700, "SEK": 5800, "CHF": 5900, "VES": 6200,
    ]
    /// The currencies whose arbitrage the bank publishes as dollars per unit (the package's ARB_DOLLARS_PER_UNIT).
    static let arbDollarsPerUnit: Set<String> = ["EUR", "GBP", "AUD", "NZD", "XDR", "UP", "UI"]
    static let bcuURL = URL(string: "https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotizaciones")!
    static let bcuPage = "https://www.bcu.gub.uy/Estadisticas-e-Indicadores/Paginas/Cotizaciones.aspx"
    static let marketURL = URL(string: "https://open.er-api.com/v6/latest/USD")!
    static let credit = Credit(label: "Rates By Exchange Rate API", href: "https://www.exchangerate-api.com")
    /// The market's past: the package's archive, a table a day since this one.
    static let pastFrom = "2024-03-02"
    static let pastCredit = Credit(label: "exchange-rates-uy", href: "https://github.com/guillecura/exchange-rates-uy")
    /// Where a month of the archive is read from, in order: the package as npm serves it, then the repository.
    static func archiveURLs(_ month: String) -> [URL] {
        [
            "https://cdn.jsdelivr.net/npm/exchange-rates-uy@1/data/market/\(month).json",
            "https://raw.githubusercontent.com/guillecura/exchange-rates-uy/main/data/market/\(month).json",
        ].compactMap(URL.init(string:))
    }

    /// The months of the archive read, kept; a month is read again after six hours when a day asked for is not in it.
    actor Archive {
        private var months: [String: (at: Date, days: [String: [String: Double]])] = [:]

        func day(_ day: String, session: URLSession) async -> [String: Double]? {
            let month = String(day.prefix(7))
            if let kept = months[month], kept.days[day] != nil || Date().timeIntervalSince(kept.at) < 6 * 3600 { return kept.days[day] }
            struct File: Decodable { let month: String; let days: [String: [String: Double]] }
            for url in Direct.archiveURLs(month) {
                guard let got = try? await session.data(for: URLRequest(url: url, timeoutInterval: 15)),
                      (got.1 as? HTTPURLResponse)?.statusCode == 200,
                      let f = try? JSONDecoder().decode(File.self, from: got.0), f.month == month else { continue }
                months[month] = (Date(), f.days)
                return f.days[day]
            }
            return nil
        }
    }

    struct Reading {
        var day: String
        var perLocal: [String: Spread]
        var published: [String: Spread]
    }

    /// The bank's readings between two days, one per day it published, earliest first.
    func bcuBetween(_ from: String, _ to: String, _ isos: [String]) async throws -> [Reading] {
        let codes = isos.compactMap { Direct.bcuCodes[$0] }
        guard !codes.isEmpty else { return [] }
        let items = codes.map { "<cot:item>\($0)</cot:item>" }.joined()
        let envelope = #"<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cot="Cotiza"><soapenv:Body><cot:wsbcucotizaciones.Execute><cot:Entrada><cot:Moneda>"#
            + items + "</cot:Moneda><cot:FechaDesde>\(from)</cot:FechaDesde><cot:FechaHasta>\(to)</cot:FechaHasta><cot:Grupo>0</cot:Grupo></cot:Entrada></cot:wsbcucotizaciones.Execute></soapenv:Body></soapenv:Envelope>"
        var request = URLRequest(url: Direct.bcuURL, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("text/xml;charset=UTF-8", forHTTPHeaderField: "Content-Type")
        request.setValue("\"\"", forHTTPHeaderField: "SOAPAction")
        request.httpBody = Data(envelope.utf8)
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { return [] }
        return Direct.parseBcu(String(decoding: data, as: UTF8.self))
    }

    static func tag(_ xml: Substring, _ name: String) -> String? {
        guard let open = xml.range(of: "<\(name)>"), let close = xml.range(of: "</\(name)>", range: open.upperBound..<xml.endIndex) else { return nil }
        return xml[open.upperBound..<close.lowerBound].trimmingCharacters(in: .whitespaces)
    }

    /// Each currency's block under its own day; the arbitrage it publishes against the dollar kept apart.
    static func parseBcu(_ xml: String) -> [Reading] {
        guard tag(Substring(xml), "status") == "1" else { return [] }
        let byCode = Dictionary(uniqueKeysWithValues: bcuCodes.map { ($0.value, $0.key) })
        var byDay: [String: Reading] = [:]
        for block in xml.components(separatedBy: "<datoscotizaciones.dato").dropFirst() {
            let b = Substring(block)
            guard let day = tag(b, "Fecha"), let code = tag(b, "Moneda").flatMap(Int.init), let iso = byCode[code],
                  let buy = tag(b, "TCC").flatMap(Double.init), buy > 0, let sell = tag(b, "TCV").flatMap(Double.init) else { continue }
            var r = byDay[day] ?? Reading(day: day, perLocal: ["UYU": Spread(buy: 1, sell: 1)], published: [:])
            r.perLocal[iso] = Spread(buy: buy, sell: sell)
            // The arbitrage comes as dollars per unit for these, units per dollar for the rest; kept as dollars per unit.
            if let arb = tag(b, "ArbAct").flatMap(Double.init), arb > 0 {
                let usd = Direct.arbDollarsPerUnit.contains(iso) ? arb : 1 / arb
                r.published["\(iso)/USD"] = Spread(buy: usd, sell: usd)
            }
            byDay[day] = r
        }
        return byDay.values.sorted { $0.day < $1.day }
    }

    /// The bank's last reading on or before `day`, walking back a week at most (weekends, bank holidays).
    func reading(_ day: String) async throws -> Reading {
        for back in 0..<7 {
            let d = Direct.shift(day, -back)
            if let r = try? await bcuBetween(d, d, isos).last { return r }
        }
        throw RatesError(status: 502, message: "the BCU published nothing in the week before that day")
    }

    func table() async throws -> (day: String, perUsd: [String: Double]) {
        struct Answer: Decodable { let result: String?; let time_last_update_unix: Double?; let rates: [String: Double]? }
        let (data, _) = try await session.data(for: URLRequest(url: Direct.marketURL, timeoutInterval: 15))
        guard let a = try? JSONDecoder().decode(Answer.self, from: data), a.result == "success", var rates = a.rates else {
            throw RatesError(status: 502, message: "ExchangeRate-API answered no table")
        }
        rates["USD"] = 1
        let day = Direct.montevideoDay(a.time_last_update_unix.map { Date(timeIntervalSince1970: $0) } ?? Date())
        return (day, rates)
    }

    /// A past day's table from the archive: that day's, or the last one before it within a week (it lacks a few days).
    func pastTable(_ day: String) async throws -> (day: String, perUsd: [String: Double]) {
        guard day >= Direct.pastFrom else { throw RatesError(status: 404, message: "the market's past begins on \(Direct.pastFrom)") }
        for back in 0..<7 {
            let d = Direct.shift(day, -back)
            if d < Direct.pastFrom { break }
            if var perUsd = await archive.day(d, session: session), perUsd["UYU"] != nil {
                perUsd["USD"] = 1
                return (d, perUsd)
            }
        }
        throw RatesError(status: 404, message: "no market table for \(day)")
    }

    // MARK: The arithmetic (the package's officialCross and marketCross)

    static func officialCross(_ perLocal: [String: Spread], _ published: [String: Spread], _ base: String, _ quote: String) -> Spread? {
        if let direct = published["\(base)/\(quote)"] { return direct }
        if let reverse = published["\(quote)/\(base)"], reverse.buy > 0, reverse.sell > 0 { return Spread(buy: 1 / reverse.sell, sell: 1 / reverse.buy) }
        guard let from = perLocal[base], let to = perLocal[quote] else { return nil }
        let buy = from.buy / to.sell
        return buy.isFinite && buy > 0 ? Spread(buy: buy, sell: from.sell / to.buy) : nil
    }

    static func marketCross(_ perUsd: [String: Double], _ base: String, _ quote: String) -> Double? {
        guard let from = perUsd[base], from > 0, let to = perUsd[quote], to > 0 else { return nil }
        return to / from
    }

    // MARK: The calls

    func official(date: String?) async throws -> Official {
        let asked = try Direct.checked(date) ?? Direct.today()
        let r = try await reading(asked)
        return Official(date: asked, day: r.day, perLocal: r.perLocal, published: r.published, quote: "UYU", source: Direct.bcuPage)
    }

    func market(date: String?) async throws -> Market {
        let asked = try Direct.checked(date) ?? Direct.today()
        return try await market(asked: asked, live: try? await table())
    }

    /// The market's table for `asked`: ExchangeRate-API's from its own day on, the archive's before it.
    func market(asked: String, live: (day: String, perUsd: [String: Double])?) async throws -> Market {
        if asked < Direct.today(), live.map({ asked < $0.day }) ?? true {
            let p = try await pastTable(asked)
            return Market(date: asked, day: p.day, perUsd: p.perUsd, base: "USD", credit: Direct.pastCredit, source: "past")
        }
        guard let t = live else { throw RatesError(status: 502, message: "ExchangeRate-API answered no table") }
        return Market(date: asked, day: t.day, perUsd: t.perUsd, base: "USD", credit: Direct.credit, source: "live")
    }

    func pairs(date: String?) async throws -> [PairRate] {
        async let o = try? official(date: date)
        async let m = try? market(date: date)
        let (bank, table) = await (o, m)
        return pairs.map { p in
            let s = bank.flatMap { Direct.officialCross($0.perLocal, $0.published, p.base, p.quote) }
            let rate = table.flatMap { Direct.marketCross($0.perUsd, p.base, p.quote) }
            return PairRate(
                pair: "\(p.base)/\(p.quote)", base: p.base, quote: p.quote, favourite: true,
                official: s.flatMap { s in bank.map { OfficialRate(day: $0.day, buy: s.buy, sell: s.sell) } },
                market: rate.flatMap { r in table.map { MarketRate(day: $0.day, rate: r) } }
            )
        }
    }

    func currencies(lang: String) -> [Currency] {
        let locale = Locale(identifier: lang)
        return isos.map { iso in
            let f = NumberFormatter()
            f.numberStyle = .currency
            f.locale = Locale(identifier: "en_US")
            f.currencyCode = iso
            return Currency(
                iso: iso, name: locale.localizedString(forCurrencyCode: iso) ?? iso, symbol: f.currencySymbol ?? iso,
                places: f.maximumFractionDigits, official: iso == "UYU" || Direct.bcuCodes[iso] != nil
            )
        }
    }

    func history(_ pair: String, from: String?, to: String?, source: Source) async throws -> [HistoryDay] {
        guard let p = Direct.sides(pair) else { throw RatesError(status: 400, message: "a pair is BASE/QUOTE") }
        let end = try Direct.checked(to) ?? Direct.today()
        let start = try Direct.checked(from) ?? Direct.shift(end, -30)
        if source == .market {
            // A month of the archive per request, kept; ten years at most, as a server answers.
            guard Direct.shift(start, 3_660) >= end else { throw RatesError(status: 400, message: "ten years of the market at most at once") }
            let live = try? await table()
            var byDay: [String: HistoryDay] = [:]
            var d = max(start, Direct.pastFrom)
            while d <= end {
                if let m = try? await market(asked: d, live: live), byDay[m.day] == nil,
                   let rate = Direct.marketCross(m.perUsd, p.base, p.quote) {
                    byDay[m.day] = HistoryDay(day: m.day, buy: rate, sell: rate, source: m.source)
                }
                d = Direct.shift(d, 1)
            }
            return byDay.values.sorted { $0.day < $1.day }
        }
        var byDay: [String: Reading] = [:]
        // One currency and one year at a time: the bank refuses wider ranges.
        var a = start
        while a <= end {
            let b = min(Direct.shift(a, 364), end)
            for iso in [p.base, p.quote] where Direct.bcuCodes[iso] != nil {
                for r in try await bcuBetween(a, b, [iso]) {
                    var had = byDay[r.day] ?? r
                    had.perLocal.merge(r.perLocal) { _, new in new }
                    had.published.merge(r.published) { _, new in new }
                    byDay[r.day] = had
                }
            }
            a = Direct.shift(b, 1)
        }
        return byDay.values.sorted { $0.day < $1.day }.compactMap { r in
            Direct.officialCross(r.perLocal, r.published, p.base, p.quote).map { HistoryDay(day: r.day, buy: $0.buy, sell: $0.sell) }
        }
    }

    func convert(_ amount: Double, from: String, to: String, date: String?, source: Source, side: Side) async throws -> Conversion {
        let f = from.uppercased(), t = to.uppercased()
        if source == .official {
            let o = try await official(date: date)
            guard let s = Direct.officialCross(o.perLocal, o.published, f, t) else { throw RatesError(status: 404, message: "no official rate for \(f)/\(t)") }
            let rate = side == .mid ? (s.buy + s.sell) / 2 : side == .buy ? s.buy : s.sell
            return Conversion(amount: amount, from: f, to: t, date: o.date, day: o.day, source: "official", side: side.rawValue, rate: rate, result: amount * rate)
        }
        let m = try await market(date: date)
        guard let rate = Direct.marketCross(m.perUsd, f, t) else { throw RatesError(status: 404, message: "no market rate for \(f)/\(t)") }
        return Conversion(amount: amount, from: f, to: t, date: m.date, day: m.day, source: "market", side: nil, rate: rate, result: amount * rate)
    }

    // MARK: Days, Montevideo's

    static let dayFormat: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "America/Montevideo")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func montevideoDay(_ date: Date) -> String { dayFormat.string(from: date) }
    static func today() -> String { montevideoDay(Date()) }

    static func shift(_ day: String, _ days: Int) -> String {
        let utc = DateFormatter()
        utc.locale = Locale(identifier: "en_US_POSIX")
        utc.timeZone = TimeZone(identifier: "UTC")
        utc.dateFormat = "yyyy-MM-dd"
        guard let d = utc.date(from: day) else { return day }
        return utc.string(from: d.addingTimeInterval(Double(days) * 86_400 + 43_200))
    }

    static func checked(_ day: String?) throws -> String? {
        guard let day else { return nil }
        guard day.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
            throw RatesError(status: 400, message: "a day is YYYY-MM-DD: \(day)")
        }
        return day
    }

    static func sides(_ pair: String) -> (base: String, quote: String)? {
        let parts = pair.uppercased().split(whereSeparator: { $0 == "/" || $0 == "-" }).map(String.init)
        return parts.count == 2 ? (parts[0], parts[1]) : nil
    }
}
