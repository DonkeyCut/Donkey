import Foundation

/// The analytics summary as /api/analytics/summary serves it, pared to the
/// fields the phone renders. The server folds the nightly rollup into this —
/// one point per day plus the headline numbers — so the phone reads tens of
/// kilobytes whatever the account table does, and no one's email or balance
/// rides along.
nonisolated public struct AnalyticsSummaryDocument: Decodable, Sendable {
    nonisolated public struct Day: Decodable, Sendable {
        public var day: String
        /// Nil on a day the pipeline never extracted: unknown, not zero.
        public var active: Int?
        public var working: Int?
        public var signups: Int
        public var totalRegistered: Int

        public init(day: String, active: Int?, working: Int?, signups: Int, totalRegistered: Int) {
            self.day = day
            self.active = active
            self.working = working
            self.signups = signups
            self.totalRegistered = totalRegistered
        }
    }

    nonisolated public struct Billing: Decodable, Sendable {
        nonisolated public struct Revenue: Decodable, Sendable {
            public var proMicros: String
            public var topupMicros: String

            public init(proMicros: String, topupMicros: String) {
                self.proMicros = proMicros
                self.topupMicros = topupMicros
            }
        }

        nonisolated public struct Canceling: Decodable, Sendable {
            public var subscriptionId: String

            public init(subscriptionId: String) {
                self.subscriptionId = subscriptionId
            }
        }

        /// The billing window, oldest → newest, ending today. It runs a day
        /// past the activity window; `revenue` aligns with this list.
        public var days: [String]
        public var subscribers: Int
        /// Live subscriptions set to end on their own.
        public var canceling: [Canceling]
        public var funded: Int
        public var fundedMicros: String
        /// Per-day paid charges, aligned with `days`.
        public var revenue: [Revenue]

        public init(
            days: [String],
            subscribers: Int,
            canceling: [Canceling],
            funded: Int,
            fundedMicros: String,
            revenue: [Revenue]
        ) {
            self.days = days
            self.subscribers = subscribers
            self.canceling = canceling
            self.funded = funded
            self.fundedMicros = fundedMicros
            self.revenue = revenue
        }
    }

    public var generatedAt: String
    /// One entry per day of the activity window, oldest → newest.
    public var series: [Day]
    public var registered: Int
    public var signups7d: Int
    public var signupsWindow: Int
    public var activeYesterday: Int?
    public var active7d: Int?
    public var activePrior7d: Int?
    /// Credit held across every account, micros as a decimal string.
    public var balanceMicros: String
    /// Days the consolidation could not read; their counts are unknown.
    public var missing: [String]
    /// Absent from summaries of rollups written before billing shipped.
    public var billing: Billing?

    public init(
        generatedAt: String,
        series: [Day],
        registered: Int,
        signups7d: Int,
        signupsWindow: Int,
        activeYesterday: Int?,
        active7d: Int?,
        activePrior7d: Int?,
        balanceMicros: String,
        missing: [String],
        billing: Billing?
    ) {
        self.generatedAt = generatedAt
        self.series = series
        self.registered = registered
        self.signups7d = signups7d
        self.signupsWindow = signupsWindow
        self.activeYesterday = activeYesterday
        self.active7d = active7d
        self.activePrior7d = activePrior7d
        self.balanceMicros = balanceMicros
        self.missing = missing
        self.billing = billing
    }

    /// Decodes the API's JSON. A body this build cannot read fails as
    /// `AnalyticsError.unreadable` naming the field, so the screen says
    /// which part of the contract moved.
    public static func decode(_ data: Data) throws -> AnalyticsSummaryDocument {
        do {
            return try JSONDecoder().decode(AnalyticsSummaryDocument.self, from: data)
        } catch let error as DecodingError {
            throw AnalyticsError.unreadable(mismatch(error))
        } catch {
            throw AnalyticsError.unreadable(error.localizedDescription)
        }
    }

    /// "billing.canceling is not an array", "series[0].signups is missing".
    static func mismatch(_ error: DecodingError) -> String {
        analyticsMismatch(error, whole: "the summary")
    }
}

/// One page of accounts as /api/analytics/users answers it: the server ranks
/// the whole window and hands back a page plus the cursor for the next one.
/// The web dashboard reads the same endpoint the same way.
nonisolated public struct AnalyticsUsersPage: Decodable, Sendable {
    nonisolated public struct Person: Decodable, Sendable, Identifiable {
        public var id: String
        public var email: String
        public var name: String
        public var registeredAt: String
        public var balanceMicros: String
        /// All-time paid charges; absent for accounts that never paid.
        public var fundedMicros: String?
        public var superUser: Bool?
        public var activeDays: Int

        public init(
            id: String,
            email: String,
            name: String,
            registeredAt: String,
            balanceMicros: String,
            fundedMicros: String? = nil,
            superUser: Bool? = nil,
            activeDays: Int
        ) {
            self.id = id
            self.email = email
            self.name = name
            self.registeredAt = registeredAt
            self.balanceMicros = balanceMicros
            self.fundedMicros = fundedMicros
            self.superUser = superUser
            self.activeDays = activeDays
        }
    }

    /// The orders the API ranks by. They come off the wire so the phone offers
    /// exactly what the server sorts by, and the web's chips read the same list.
    nonisolated public struct Sort: Decodable, Sendable, Identifiable, Equatable {
        public var id: String
        public var label: String

        public init(id: String, label: String) {
            self.id = id
            self.label = label
        }
    }

    /// The rollup these ranks came from. A page stamped with a different one
    /// belongs to a different order.
    public var generatedAt: String
    public var users: [Person]
    public var total: Int
    /// The offset of the next page, or nil at the end of the list.
    public var nextCursor: Int?
    public var sorts: [Sort]
    public var pageSize: Int

    public init(
        generatedAt: String,
        users: [Person],
        total: Int,
        nextCursor: Int?,
        sorts: [Sort],
        pageSize: Int
    ) {
        self.generatedAt = generatedAt
        self.users = users
        self.total = total
        self.nextCursor = nextCursor
        self.sorts = sorts
        self.pageSize = pageSize
    }

    public static func decode(_ data: Data) throws -> AnalyticsUsersPage {
        do {
            return try JSONDecoder().decode(AnalyticsUsersPage.self, from: data)
        } catch let error as DecodingError {
            throw AnalyticsError.unreadable(analyticsMismatch(error, whole: "the page"))
        } catch {
            throw AnalyticsError.unreadable(error.localizedDescription)
        }
    }
}

/// Names the field a decoder tripped on, so a screen can say which part of the
/// contract moved: "billing.canceling is not an array", "users[0].email is
/// missing".
nonisolated func analyticsMismatch(_ error: DecodingError, whole: String) -> String {
    func path(_ context: DecodingError.Context) -> String {
        let joined = context.codingPath.reduce(into: "") { text, key in
            if let index = key.intValue {
                text += "[\(index)]"
            } else {
                text += text.isEmpty ? key.stringValue : ".\(key.stringValue)"
            }
        }
        return joined.isEmpty ? whole : joined
    }
    func name(_ type: Any.Type) -> String {
        switch type {
        case is String.Type: return "a string"
        case is Bool.Type: return "a boolean"
        case is Int.Type, is Double.Type, is Float.Type, is Int64.Type, is UInt.Type: return "a number"
        default:
            let text = String(describing: type)
            if text.hasPrefix("Array<") { return "an array" }
            if text.hasPrefix("Dictionary<") { return "an object" }
            return text
        }
    }
    switch error {
    case .typeMismatch(let type, let context):
        return "\(path(context)) is not \(name(type))"
    case .valueNotFound(let type, let context):
        return "\(path(context)) is null, expected \(name(type))"
    case .keyNotFound(let key, let context):
        let parent = path(context)
        return parent == whole ? "\(key.stringValue) is missing" : "\(parent).\(key.stringValue) is missing"
    case .dataCorrupted(let context):
        return context.debugDescription
    @unknown default:
        return String(describing: error)
    }
}

/// The summary in the shapes the charts draw: days as dates, money as dollars.
nonisolated public struct AnalyticsSummary: Sendable, Equatable {
    nonisolated public struct DayPoint: Sendable, Equatable, Identifiable {
        public var day: Date
        /// Nil on a day without an extract: unknown, not zero.
        public var active: Int?
        /// Actives narrowed to the DB event sources — did something, not just opened the app.
        public var working: Int?
        public var signups: Int
        public var totalRegistered: Int

        public var id: Date { day }

        public init(day: Date, active: Int?, working: Int?, signups: Int, totalRegistered: Int) {
            self.day = day
            self.active = active
            self.working = working
            self.signups = signups
            self.totalRegistered = totalRegistered
        }
    }

    /// One day of the billing window. That window ends today, a day past
    /// the activity points, so money charts on its own axis.
    nonisolated public struct RevenuePoint: Sendable, Equatable, Identifiable {
        public var day: Date
        public var proDollars: Double
        public var topupDollars: Double

        public var id: Date { day }
        public var revenueDollars: Double { proDollars + topupDollars }

        public init(day: Date, proDollars: Double, topupDollars: Double) {
            self.day = day
            self.proDollars = proDollars
            self.topupDollars = topupDollars
        }
    }

    public var points: [DayPoint]
    /// Paid charges per day across the billing window; empty when the rollup
    /// predates billing.
    public var revenue: [RevenuePoint]
    public var registered: Int
    public var signups7d: Int
    public var signupsWindow: Int
    public var activeYesterday: Int?
    public var active7d: Int?
    /// Active last 7 days against the prior 7; nil without a baseline.
    public var weekDeltaPercent: Double?
    public var balanceDollars: Double
    public var subscribers: Int?
    public var canceling: Int?
    public var funded: Int?
    public var fundedDollars: Double?
    /// Paid charges across the window; nil when the rollup predates billing.
    public var revenueDollars: Double?
    public var missingDayCount: Int
    public var generatedAt: Date?

    public init(document: AnalyticsSummaryDocument) {
        points = document.series.map { day in
            DayPoint(
                day: Self.date(fromDay: day.day),
                active: day.active,
                working: day.working,
                signups: day.signups,
                totalRegistered: day.totalRegistered
            )
        }
        // Money rides the billing window, which runs through today.
        let revenue = document.billing.map { billing in
            zip(billing.days, billing.revenue).map { day, entry in
                RevenuePoint(
                    day: Self.date(fromDay: day),
                    proDollars: Self.dollars(fromMicros: entry.proMicros),
                    topupDollars: Self.dollars(fromMicros: entry.topupMicros)
                )
            }
        } ?? []
        self.revenue = revenue
        registered = document.registered
        signups7d = document.signups7d
        signupsWindow = document.signupsWindow
        activeYesterday = document.activeYesterday
        active7d = document.active7d
        weekDeltaPercent = if let active7d = document.active7d,
            let prior = document.activePrior7d, prior > 0 {
            Double(active7d - prior) / Double(prior) * 100
        } else {
            nil
        }
        balanceDollars = Self.dollars(fromMicros: document.balanceMicros)
        subscribers = document.billing?.subscribers
        canceling = document.billing?.canceling.count
        funded = document.billing?.funded
        fundedDollars = document.billing.map { Self.dollars(fromMicros: $0.fundedMicros) }
        revenueDollars = document.billing.map { _ in revenue.reduce(0) { $0 + $1.revenueDollars } }
        missingDayCount = document.missing.count
        generatedAt = Self.timestamp(from: document.generatedAt)
    }

    private static func dollars(fromMicros micros: String) -> Double {
        (Double(micros) ?? 0) / 1_000_000
    }

    /// "YYYY-MM-DD" as midnight UTC, matching the summary's day keys.
    private static func date(fromDay day: String) -> Date {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        var components = DateComponents()
        components.year = parts.count > 0 ? parts[0] : nil
        components.month = parts.count > 1 ? parts[1] : nil
        components.day = parts.count > 2 ? parts[2] : nil
        return utcCalendar.date(from: components) ?? .distantPast
    }

    private static let utcCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar
    }()

    /// The summary stamps milliseconds (JS toISOString).
    private static func timestamp(from string: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) { return date }
        return ISO8601DateFormatter().date(from: string)
    }
}

nonisolated public enum AnalyticsError: Error, Equatable {
    /// The nightly job hasn't written a rollup yet.
    case noRollup
    /// The answer came back, and it was not a summary this build can read;
    /// the text names the field that moved.
    case unreadable(String)
}

/// What the app target's CutCloudClient does for the analytics dashboard.
public protocol AnalyticsServicing: AnyObject {
    func fetchAnalyticsSummary() async throws -> AnalyticsSummaryDocument
    func fetchAnalyticsUsers(sort: String, cursor: Int) async throws -> AnalyticsUsersPage
}

@Observable
public final class AnalyticsModel {
    public enum State {
        case loading
        case loaded(AnalyticsSummary)
        /// The API answered but no rollup exists yet.
        case empty
        /// The load failed, in words that name the cause.
        case failed(String)
    }

    public private(set) var state: State = .loading

    /// The accounts list, in the order the API ranked them. It arrives a page
    /// at a time — the phone asks for the first page and follows the cursor,
    /// exactly as the web dashboard does — so neither client ever holds the
    /// whole account table.
    public private(set) var people: [AnalyticsUsersPage.Person] = []
    /// The orders the API offers, as it named them.
    public private(set) var sorts: [AnalyticsUsersPage.Sort] = []
    public private(set) var sort = "active"
    public private(set) var peopleTotal = 0
    public private(set) var isLoadingPeople = false
    /// Set when a page failed; the list keeps whatever already loaded.
    public private(set) var peopleError: String?
    /// The offset of the next page, or nil at the end of the list.
    private var nextCursor: Int? = 0
    /// The rollup the loaded pages were ranked against.
    private var peopleStamp: String?

    private let service: any AnalyticsServicing

    public init(service: any AnalyticsServicing) {
        self.service = service
    }

    /// Whether another page exists to ask for.
    public var hasMorePeople: Bool { nextCursor != nil }

    /// Loads the next page, if there is one and none is in flight. The list
    /// view calls this as its last row comes into view.
    public func loadMorePeople() async {
        guard !isLoadingPeople, let cursor = nextCursor else { return }
        await loadPeople(cursor: cursor)
    }

    /// Switches the order. Ranks are per order, so the list starts over.
    public func choosePeople(sort: String) async {
        guard sort != self.sort else { return }
        self.sort = sort
        resetPeople()
        await loadPeople(cursor: 0)
    }

    private func resetPeople() {
        people = []
        peopleTotal = 0
        nextCursor = 0
        peopleStamp = nil
        peopleError = nil
    }

    private func loadPeople(cursor: Int) async {
        isLoadingPeople = true
        defer { isLoadingPeople = false }
        do {
            let page = try await service.fetchAnalyticsUsers(sort: sort, cursor: cursor)
            // A nightly run landing while the list is open reorders the ranks,
            // so pages from the older order are dropped rather than stitched
            // onto the new one.
            if let stamp = peopleStamp, stamp != page.generatedAt, cursor > 0 {
                resetPeople()
                await loadPeople(cursor: 0)
                return
            }
            peopleStamp = page.generatedAt
            people = cursor == 0 ? page.users : people + page.users
            peopleTotal = page.total
            nextCursor = page.nextCursor
            if !page.sorts.isEmpty { sorts = page.sorts }
            peopleError = nil
        } catch is CancellationError {
            return
        } catch {
            peopleError = Self.reason(for: error)
        }
    }

    /// Fetches the summary. A refresh over loaded data keeps the charts up
    /// while it runs and on failure; a retry over a failure spins, so the tap
    /// shows something happening. A first load surfaces the error, saying
    /// which one it was — a failure that only reads "try again" tells nobody
    /// whether the phone, the session, or the server is at fault.
    ///
    /// A cancelled fetch is the screen closing, so it leaves the state alone.
    public func refresh() async {
        if case .failed = state { state = .loading }
        do {
            let document = try await service.fetchAnalyticsSummary()
            state = .loaded(AnalyticsSummary(document: document))
            // The numbers and the list come from the same rollup, so a refresh
            // takes the list back to its first page.
            resetPeople()
            await loadPeople(cursor: 0)
        } catch AnalyticsError.noRollup {
            state = .empty
        } catch is CancellationError {
            return
        } catch {
            if case .loaded = state { return }
            state = .failed(Self.reason(for: error))
        }
    }

    private static func reason(for error: any Error) -> String {
        switch error {
        case CloudSyncError.unauthorized:
            "This account can't read analytics. Sign out and back in."
        case CloudSyncError.refused(let message):
            message
        case CloudSyncError.unreachable(let reach, let code):
            "\(reach.sentence) (\(code))"
        case AnalyticsError.unreadable(let detail):
            "The summary came back in a shape this build doesn't read: \(detail)."
        default:
            "The summary didn't load. Try again."
        }
    }
}
