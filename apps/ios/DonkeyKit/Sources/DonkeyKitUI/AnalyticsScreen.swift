#if os(iOS)
import Charts
import DonkeyKitModels
import SwiftUI

/// The super-user dashboard: the nightly rollup as a stat grid and borderless
/// chart sections, opened from the avatar menu.
public struct AnalyticsScreen: View {
    var analytics: AnalyticsModel
    @Environment(\.dismiss) private var dismiss

    public init(analytics: AnalyticsModel) {
        self.analytics = analytics
    }

    public var body: some View {
        NavigationStack {
            Group {
                switch analytics.state {
                case .loading:
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .empty:
                    EmptyState(
                        title: "No data yet",
                        message: "The nightly analytics job hasn't produced a rollup."
                    )
                case .failed(let error):
                    EmptyState(
                        title: Self.title(for: error),
                        message: Self.message(for: error),
                        actionTitle: "Retry"
                    ) {
                        Task { await analytics.refresh() }
                    }
                case .loaded(let summary):
                    SummaryList(summary: summary)
                        .refreshable { await analytics.refresh() }
                }
            }
            .navigationTitle("Analytics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .task { await analytics.refresh() }
    }

    /// One line per reason the dashboard came back empty-handed, so the screen
    /// names the one that happened and the reader knows what to do about it.
    private static func title(for error: AnalyticsError) -> String {
        switch error {
        case .offline: "Couldn't reach donkeycut.com"
        case .signedOut: "Signed out"
        case .notSuperUser: "Not this account"
        case .server: "The server couldn't serve it"
        case .malformed, .noRollup: "Couldn't read the analytics"
        }
    }

    private static func message(for error: AnalyticsError) -> String {
        switch error {
        case .offline: "The request never got an answer. Check your connection and try again."
        case .signedOut: "This session isn't good any more. Sign out and back in."
        case .notSuperUser: "The dashboard is for super users, and this account isn't one."
        case .server(let status): "donkeycut.com answered \(status). Give it a moment and retry."
        case .malformed, .noRollup: "The answer wasn't in a shape this build reads. Update the app."
        }
    }
}

private struct SummaryList: View {
    let summary: AnalyticsSummary

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                StatGrid(summary: summary)
                    .padding(.vertical, 20)

                Divider()
                MetricSection(
                    title: "Total registered",
                    value: summary.registered.formatted(),
                    caption: "Cumulative registrations"
                ) {
                    RegisteredChart(points: summary.points)
                }

                Divider()
                MetricSection(
                    title: "Signups",
                    value: summary.signupsWindow.formatted(),
                    caption: "Last \(summary.points.count) days"
                ) {
                    SignupsChart(points: summary.points)
                }

                if let revenueDollars = summary.revenueDollars {
                    Divider()
                    MetricSection(
                        title: "Revenue",
                        value: dollars(revenueDollars),
                        caption: "Paid charges, last \(summary.points.count) days"
                    ) {
                        RevenueChart(points: summary.points)
                    }
                }

                Divider()
                MetricSection(
                    title: "Active users",
                    value: summary.active7d.map { $0.formatted() } ?? "—",
                    caption: activeCaption,
                    deltaPercent: summary.weekDeltaPercent
                ) {
                    ActiveChart(points: summary.points)
                }

                if let generatedAt = summary.generatedAt {
                    Text("From the nightly rollup generated \(generatedAt.formatted(date: .abbreviated, time: .shortened)).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 16)
                }
            }
            .padding(.horizontal, 20)
        }
    }

    private var activeCaption: String {
        let base = "Active in the last 7 days"
        guard summary.missingDayCount > 0 else { return base }
        return "\(base) · \(summary.missingDayCount) days without data"
    }
}

// MARK: - Stats

private struct StatGrid: View {
    let summary: AnalyticsSummary

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), alignment: .topLeading), GridItem(.flexible(), alignment: .topLeading)], spacing: 20) {
            StatTile(
                label: "Registered users",
                value: summary.registered.formatted(),
                sub: "+\(summary.signups7d.formatted()) last 7 days"
            )
            StatTile(
                label: "Active yesterday",
                value: summary.activeYesterday.map { $0.formatted() } ?? "—",
                sub: summary.activeYesterday == nil ? "no extract yet" : "of \(summary.registered.formatted()) registered"
            )
            StatTile(
                label: "Pro subscribers",
                value: summary.subscribers.map { $0.formatted() } ?? "—",
                sub: summary.canceling.map { "\($0.formatted()) canceling" } ?? "not in this rollup"
            )
            StatTile(
                label: "Paid all time",
                value: summary.fundedDollars.map(dollars) ?? "—",
                sub: summary.funded.map { "by \($0.formatted()) people" } ?? "not in this rollup"
            )
        }
    }
}

private struct StatTile: View {
    let label: String
    let value: String
    let sub: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.weight(.semibold))
                .monospacedDigit()
            Text(sub)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Sections

private struct MetricSection<ChartContent: View>: View {
    let title: String
    let value: String
    let caption: String
    var deltaPercent: Double?
    @ViewBuilder let chart: () -> ChartContent

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.headline)
                Spacer()
                if let deltaPercent {
                    DeltaBadge(percent: deltaPercent)
                }
            }
            Text(value)
                .font(.title.weight(.semibold))
                .monospacedDigit()
            Text(caption)
                .font(.footnote)
                .foregroundStyle(.secondary)
            chart()
                .frame(height: 200)
                .padding(.top, 16)
        }
        .padding(.vertical, 20)
    }
}

private struct DeltaBadge: View {
    let percent: Double

    var body: some View {
        Text("\(percent >= 0 ? "+" : "")\(percent.formatted(.number.precision(.fractionLength(1))))%")
            .font(.footnote.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(percent < 0 ? .red : .green)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background((percent < 0 ? Color.red : Color.green).opacity(0.12), in: Capsule())
    }
}

// MARK: - Charts

private let workingPurple = Color(hex: "#9d7bff")

private struct ActiveChart: View {
    let points: [AnalyticsSummary.DayPoint]

    var body: some View {
        Chart {
            ForEach(points.filter { $0.active != nil }) { point in
                LineMark(
                    x: .value("Day", point.day, unit: .day),
                    y: .value("Users", point.active ?? 0)
                )
                .foregroundStyle(by: .value("Series", "Active"))
                .interpolationMethod(.monotone)
            }
            ForEach(points.filter { $0.working != nil }) { point in
                LineMark(
                    x: .value("Day", point.day, unit: .day),
                    y: .value("Users", point.working ?? 0)
                )
                .foregroundStyle(by: .value("Series", "Working"))
                .interpolationMethod(.monotone)
            }
        }
        .chartForegroundStyleScale(["Active": Color.accentBlue, "Working": workingPurple])
        .chartLegend(position: .bottom, spacing: 12)
        .analyticsAxes()
    }
}

private struct SignupsChart: View {
    let points: [AnalyticsSummary.DayPoint]

    var body: some View {
        Chart(points) { point in
            BarMark(
                x: .value("Day", point.day, unit: .day),
                y: .value("Signups", point.signups)
            )
            .foregroundStyle(Color.accentBlue)
        }
        .analyticsAxes()
    }
}

private struct RevenueChart: View {
    let points: [AnalyticsSummary.DayPoint]

    var body: some View {
        Chart {
            ForEach(points) { point in
                BarMark(
                    x: .value("Day", point.day, unit: .day),
                    y: .value("Dollars", point.proDollars)
                )
                .foregroundStyle(by: .value("Series", "Pro"))
                BarMark(
                    x: .value("Day", point.day, unit: .day),
                    y: .value("Dollars", point.topupDollars)
                )
                .foregroundStyle(by: .value("Series", "Top-ups"))
            }
        }
        .chartForegroundStyleScale(["Pro": Color.accentBlue, "Top-ups": workingPurple])
        .chartLegend(position: .bottom, spacing: 12)
        .analyticsAxes()
    }
}

private struct RegisteredChart: View {
    let points: [AnalyticsSummary.DayPoint]

    var body: some View {
        Chart(points) { point in
            LineMark(
                x: .value("Day", point.day, unit: .day),
                y: .value("Users", point.totalRegistered)
            )
            .foregroundStyle(Color.accentBlue)
            .interpolationMethod(.monotone)
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .analyticsAxes()
    }
}

extension View {
    fileprivate func analyticsAxes() -> some View {
        chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) {
                AxisGridLine()
                AxisValueLabel(format: .dateTime.month(.abbreviated).day(), centered: false)
            }
        }
    }
}

private func dollars(_ value: Double) -> String {
    value.formatted(.currency(code: "USD").precision(.fractionLength(value == value.rounded() ? 0 : 2)))
}
#endif
