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

        public var subscribers: Int
        public var canceling: Int
        public var funded: Int
        public var fundedMicros: String
        /// Per-day paid charges, aligned with `days`.
        public var revenue: [Revenue]

        public init(subscribers: Int, canceling: Int, funded: Int, fundedMicros: String, revenue: [Revenue]) {
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
        public var proDollars: Double
        public var topupDollars: Double

        public var id: Date { day }
        public var revenueDollars: Double { proDollars + topupDollars }

        public init(
            day: Date,
            active: Int?,
            working: Int?,
            signups: Int,
            totalRegistered: Int,
            proDollars: Double,
            topupDollars: Double
        ) {
            self.day = day
            self.active = active
            self.working = working
            self.signups = signups
            self.totalRegistered = totalRegistered
            self.proDollars = proDollars
            self.topupDollars = topupDollars
        }
    }

    public var points: [DayPoint]
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
            let revenue = rollup.billing.flatMap { $0.revenue.indices.contains(i) ? $0.revenue[i] : nil }
            points.append(DayPoint(
                day: Self.date(fromDay: day),
                active: active,
                working: working,
                signups: signups,
                totalRegistered: totalRegistered,
                proDollars: Self.dollars(fromMicros: revenue?.proMicros ?? "0"),
                topupDollars: Self.dollars(fromMicros: revenue?.topupMicros ?? "0")
            ))
        }

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
        canceling = rollup.billing?.canceling
        funded = rollup.billing?.funded
        fundedDollars = rollup.billing.map { Self.dollars(fromMicros: $0.fundedMicros) }
        revenueDollars = rollup.billing.map { _ in points.reduce(0) { $0 + $1.revenueDollars } }
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
    /// The answer came back, and it was not a rollup this build can read.
    case unreadable
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
        case AnalyticsError.unreadable:
            "The rollup came back in a shape this build doesn't read."
        default:
            "The rollup didn't load. Try again."
        }
    }
}
