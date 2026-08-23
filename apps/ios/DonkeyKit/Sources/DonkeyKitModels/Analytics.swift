import Foundation

/// The dashboard as /api/analytics/summary serves it: one point per day plus
/// the headline numbers, already derived from the nightly rollup. The rollup
/// itself is one row per registered account — email, balance, and a 60-day
/// activity mask — and grows with every signup, so the phone never asks for it.
nonisolated public struct AnalyticsSummary: Decodable, Sendable, Equatable {
    nonisolated public struct DayPoint: Decodable, Sendable, Equatable, Identifiable {
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

        private enum CodingKeys: String, CodingKey {
            case day, active, working, signups, totalRegistered, proDollars, topupDollars
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            day = AnalyticsSummary.date(fromDay: try container.decode(String.self, forKey: .day))
            active = try container.decodeIfPresent(Int.self, forKey: .active)
            working = try container.decodeIfPresent(Int.self, forKey: .working)
            signups = try container.decode(Int.self, forKey: .signups)
            totalRegistered = try container.decode(Int.self, forKey: .totalRegistered)
            proDollars = try container.decode(Double.self, forKey: .proDollars)
            topupDollars = try container.decode(Double.self, forKey: .topupDollars)
        }

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
    public var subscribers: Int?
    public var canceling: Int?
    public var funded: Int?
    public var fundedDollars: Double?
    /// Paid charges across the window; nil when the rollup predates billing.
    public var revenueDollars: Double?
    public var missingDayCount: Int
    public var generatedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case points, registered, signups7d, signupsWindow, activeYesterday, active7d
        case weekDeltaPercent, subscribers, canceling, funded, fundedDollars
        case revenueDollars, missingDayCount, generatedAt
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        points = try container.decode([DayPoint].self, forKey: .points)
        registered = try container.decode(Int.self, forKey: .registered)
        signups7d = try container.decode(Int.self, forKey: .signups7d)
        signupsWindow = try container.decode(Int.self, forKey: .signupsWindow)
        activeYesterday = try container.decodeIfPresent(Int.self, forKey: .activeYesterday)
        active7d = try container.decodeIfPresent(Int.self, forKey: .active7d)
        weekDeltaPercent = try container.decodeIfPresent(Double.self, forKey: .weekDeltaPercent)
        subscribers = try container.decodeIfPresent(Int.self, forKey: .subscribers)
        canceling = try container.decodeIfPresent(Int.self, forKey: .canceling)
        funded = try container.decodeIfPresent(Int.self, forKey: .funded)
        fundedDollars = try container.decodeIfPresent(Double.self, forKey: .fundedDollars)
        revenueDollars = try container.decodeIfPresent(Double.self, forKey: .revenueDollars)
        missingDayCount = try container.decode(Int.self, forKey: .missingDayCount)
        let stamp = try container.decodeIfPresent(String.self, forKey: .generatedAt)
        generatedAt = stamp.flatMap(Self.timestamp(from:))
    }

    /// "YYYY-MM-DD" as midnight UTC, matching the rollup's day keys.
    fileprivate static func date(fromDay day: String) -> Date {
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

/// Why the dashboard has nothing to draw. Each case asks for a different thing
/// from the reader, so each one reaches the screen as itself.
nonisolated public enum AnalyticsError: Error, Equatable {
    /// The nightly job hasn't written a rollup yet.
    case noRollup
    /// The request never reached an answer.
    case offline
    /// The session the keychain holds is no longer good.
    case signedOut
    /// A valid session on an account without the super-user role.
    case notSuperUser
    /// The API answered, and the answer was a failure.
    case server(status: Int)
    /// The API answered with something this build can't read.
    case malformed
}

/// What the app target's CutCloudClient does for the analytics dashboard.
public protocol AnalyticsServicing: AnyObject {
    func fetchAnalyticsSummary() async throws -> AnalyticsSummary
}

@Observable
public final class AnalyticsModel {
    public enum State {
        case loading
        case loaded(AnalyticsSummary)
        /// The API answered but no rollup exists yet.
        case empty
        case failed(AnalyticsError)
    }

    public private(set) var state: State = .loading

    private let service: any AnalyticsServicing

    public init(service: any AnalyticsServicing) {
        self.service = service
    }

    /// Fetches the summary. A refresh over loaded data keeps the charts up
    /// while it runs and on failure; a first load surfaces the error.
    public func refresh() async {
        do {
            let summary = try await service.fetchAnalyticsSummary()
            state = .loaded(summary)
        } catch AnalyticsError.noRollup {
            state = .empty
        } catch {
            if case .loaded = state { return }
            state = .failed(error as? AnalyticsError ?? .offline)
        }
    }
}
