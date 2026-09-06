import Foundation

/// The nightly analytics rollup as /api/analytics/rollup serves it, pared to
/// the fields the phone renders.
nonisolated public struct AnalyticsRollup: Decodable, Sendable {
    nonisolated public struct MissingEntry: Decodable, Sendable {
        public var day: String

        public init(day: String) {
            self.day = day
        }
    }

    nonisolated public struct User: Decodable, Sendable {
        public var registeredAt: String
        public var balanceMicros: String
        /// One source bitmask per entry of `days`.
        public var activity: [Int]

        public init(registeredAt: String, balanceMicros: String, activity: [Int]) {
            self.registeredAt = registeredAt
            self.balanceMicros = balanceMicros
            self.activity = activity
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
    /// Oldest → newest; every user's activity array aligns with this.
    public var days: [String]
    /// Bit order of the activity masks.
    public var sources: [String]
    /// Days the consolidation could not read; their counts are unknown.
    public var missing: [MissingEntry]
    /// Absent from rollups written before billing shipped.
    public var billing: Billing?
    public var users: [User]

    public init(
        generatedAt: String,
        days: [String],
        sources: [String],
        missing: [MissingEntry],
        billing: Billing?,
        users: [User]
    ) {
        self.generatedAt = generatedAt
        self.days = days
        self.sources = sources
        self.missing = missing
        self.billing = billing
        self.users = users
    }

    /// Decodes the API's JSON. A body this build cannot read fails as
    /// `AnalyticsError.unreadable` naming the field, so the screen says
    /// which part of the contract moved.
    public static func decode(_ data: Data) throws -> AnalyticsRollup {
        do {
            return try JSONDecoder().decode(AnalyticsRollup.self, from: data)
        } catch let error as DecodingError {
            throw AnalyticsError.unreadable(mismatch(error))
        } catch {
            throw AnalyticsError.unreadable(error.localizedDescription)
        }
    }

    /// "billing.canceling is not an array", "users[0].activity is missing".
    static func mismatch(_ error: DecodingError) -> String {
        func path(_ context: DecodingError.Context) -> String {
            let joined = context.codingPath.reduce(into: "") { text, key in
                if let index = key.intValue {
                    text += "[\(index)]"
                } else {
                    text += text.isEmpty ? key.stringValue : ".\(key.stringValue)"
                }
            }
            return joined.isEmpty ? "the rollup" : joined
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
            return parent == "the rollup" ? "\(key.stringValue) is missing" : "\(parent).\(key.stringValue) is missing"
        case .dataCorrupted(let context):
            return context.debugDescription
        @unknown default:
            return String(describing: error)
        }
    }
}

/// The rollup reduced to what the dashboard draws: one point per day plus the
/// headline numbers. Pure derivation, mirrored from the web dashboard.
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

    public init(rollup: AnalyticsRollup) {
        // Any source bit marks a day active; the DB sources mark it working.
        let workBits = rollup.sources.enumerated().reduce(0) { mask, entry in
            entry.element == "posthog" ? mask : mask | (1 << entry.offset)
        }
        let missingDays = Set(rollup.missing.map(\.day))

        var signupsByDay: [String: Int] = [:]
        for user in rollup.users {
            signupsByDay[String(user.registeredAt.prefix(10)), default: 0] += 1
        }

        // Cumulative registrations start from everyone who signed up before
        // the window, so the total line carries the real base.
        let firstDay = rollup.days.first ?? ""
        var totalRegistered = rollup.users.filter { String($0.registeredAt.prefix(10)) < firstDay }.count

        var points: [DayPoint] = []
        for (i, day) in rollup.days.enumerated() {
            let signups = signupsByDay[day] ?? 0
            totalRegistered += signups
            var active: Int?
            var working: Int?
            if !missingDays.contains(day) {
                var visited = 0
                var worked = 0
                for user in rollup.users {
                    let mask = i < user.activity.count ? user.activity[i] : 0
                    if mask != 0 { visited += 1 }
                    if mask & workBits != 0 { worked += 1 }
                }
                active = visited
                working = worked
            }
            points.append(DayPoint(
                day: Self.date(fromDay: day),
                active: active,
                working: working,
                signups: signups,
                totalRegistered: totalRegistered
            ))
        }

        // Money rides the billing window, which runs through today.
        let revenue = rollup.billing.map { billing in
            zip(billing.days, billing.revenue).map { day, entry in
                RevenuePoint(
                    day: Self.date(fromDay: day),
                    proDollars: Self.dollars(fromMicros: entry.proMicros),
                    topupDollars: Self.dollars(fromMicros: entry.topupMicros)
                )
            }
        } ?? []

        // Counts users active on any known day in the range; nil when the
        // whole range went unextracted.
        let activeInRange = { (from: Int, to: Int) -> Int? in
            let known = (max(0, from)..<max(0, to)).filter { !missingDays.contains(rollup.days[$0]) }
            guard !known.isEmpty else { return nil }
            return rollup.users.filter { user in
                known.contains { ($0 < user.activity.count ? user.activity[$0] : 0) != 0 }
            }.count
        }

        let len = rollup.days.count
        let active7d = activeInRange(len - 7, len)
        let activePrior7d = activeInRange(len - 14, len - 7)

        self.points = points
        self.revenue = revenue
        registered = rollup.users.count
        signups7d = rollup.days.suffix(7).reduce(0) { $0 + (signupsByDay[$1] ?? 0) }
        signupsWindow = points.reduce(0) { $0 + $1.signups }
        activeYesterday = points.last?.active ?? nil
        self.active7d = active7d
        weekDeltaPercent = if let active7d, let activePrior7d, activePrior7d > 0 {
            Double(active7d - activePrior7d) / Double(activePrior7d) * 100
        } else {
            nil
        }
        balanceDollars = rollup.users.reduce(0) { $0 + Self.dollars(fromMicros: $1.balanceMicros) }
        subscribers = rollup.billing?.subscribers
        canceling = rollup.billing?.canceling.count
        funded = rollup.billing?.funded
        fundedDollars = rollup.billing.map { Self.dollars(fromMicros: $0.fundedMicros) }
        revenueDollars = rollup.billing.map { _ in revenue.reduce(0) { $0 + $1.revenueDollars } }
        missingDayCount = missingDays.count
        generatedAt = Self.timestamp(from: rollup.generatedAt)
    }

    private static func dollars(fromMicros micros: String) -> Double {
        (Double(micros) ?? 0) / 1_000_000
    }

    /// "YYYY-MM-DD" as midnight UTC, matching the rollup's day keys.
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

    /// The rollup stamps milliseconds (JS toISOString).
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
    /// The answer came back, and it was not a rollup this build can read;
    /// the text names the field that moved.
    case unreadable(String)
}

/// What the app target's CutCloudClient does for the analytics dashboard.
public protocol AnalyticsServicing: AnyObject {
    func fetchAnalyticsRollup() async throws -> AnalyticsRollup
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

    private let service: any AnalyticsServicing

    public init(service: any AnalyticsServicing) {
        self.service = service
    }

    /// Fetches the rollup. A refresh over loaded data keeps the charts up
    /// while it runs and on failure; a retry over a failure spins, so the tap
    /// shows something happening. A first load surfaces the error, saying
    /// which one it was — a failure that only reads "try again" tells nobody
    /// whether the phone, the session, or the server is at fault.
    ///
    /// A cancelled fetch is the screen closing, so it leaves the state alone.
    public func refresh() async {
        if case .failed = state { state = .loading }
        do {
            let rollup = try await service.fetchAnalyticsRollup()
            state = .loaded(AnalyticsSummary(rollup: rollup))
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
            "The rollup came back in a shape this build doesn't read: \(detail)."
        default:
            "The rollup didn't load. Try again."
        }
    }
}
