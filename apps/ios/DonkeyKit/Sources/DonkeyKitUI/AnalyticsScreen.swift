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
                        title: String(localized: "No data yet"),
                        message: String(localized: "The nightly analytics job hasn't produced a rollup.")
                    )
                case .failed(let reason):
                    EmptyState(
                        title: String(localized: "Couldn't load analytics"),
                        message: reason,
                        actionTitle: String(localized: "Retry")
                    ) {
                        Task { await analytics.refresh() }
                    }
                case .loaded(let summary):
                    SummaryList(analytics: analytics, summary: summary)
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
}

private struct SummaryList: View {
    var analytics: AnalyticsModel
    let summary: AnalyticsSummary

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                StatGrid(summary: summary)
                    .padding(.vertical, 20)

                Divider()
                MetricSection(
                    title: String(localized: "Total registered"),
                    value: summary.registered.formatted(),
                    caption: String(localized: "Cumulative registrations")
                ) {
                    RegisteredChart(points: summary.points)
                }

                Divider()
                MetricSection(
                    title: String(localized: "Signups"),
                    value: summary.signupsWindow.formatted(),
                    caption: String(localized: "Last \(summary.points.count) days")
                ) {
                    SignupsChart(points: summary.points)
                }

                if let revenueDollars = summary.revenueDollars {
                    Divider()
                    MetricSection(
                        title: String(localized: "Revenue"),
                        value: dollars(revenueDollars),
                        caption: String(localized: "Paid charges, last \(summary.revenue.count) days")
                    ) {
                        RevenueChart(points: summary.revenue)
                    }
                }

                Divider()
                MetricSection(
                    title: String(localized: "Active users"),
                    value: summary.active7d.map { $0.formatted() } ?? "—",
                    caption: activeCaption,
                    deltaPercent: summary.weekDeltaPercent
                ) {
                    ActiveChart(points: summary.points)
                }

                Divider()
                PeopleSection(analytics: analytics)

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
        guard summary.missingDayCount > 0 else { return String(localized: "Active in the last 7 days") }
        return String(localized: "Active in the last 7 days · \(summary.missingDayCount) days without data")
    }
}

// MARK: - Stats

private struct StatGrid: View {
    let summary: AnalyticsSummary

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), alignment: .topLeading), GridItem(.flexible(), alignment: .topLeading)], spacing: 20) {
            StatTile(
                label: String(localized: "Registered users"),
                value: summary.registered.formatted(),
                sub: String(localized: "+\(summary.signups7d.formatted()) last 7 days")
            )
            StatTile(
                label: String(localized: "Active yesterday"),
                value: summary.activeYesterday.map { $0.formatted() } ?? "—",
                sub: summary.activeYesterday == nil
                    ? String(localized: "no extract yet")
                    : String(localized: "of \(summary.registered.formatted()) registered")
            )
            StatTile(
                label: String(localized: "Pro subscribers"),
                value: summary.subscribers.map { $0.formatted() } ?? "—",
                sub: summary.canceling.map { String(localized: "\($0.formatted()) canceling") }
                    ?? String(localized: "not in this rollup")
            )
            StatTile(
                label: String(localized: "Paid all time"),
                value: summary.fundedDollars.map(dollars) ?? "—",
                sub: summary.funded.map { String(localized: "by \($0.formatted()) people") }
                    ?? String(localized: "not in this rollup")
            )
        }
    }
}

/// The accounts the API ranks, a page at a time. The rows arrive as the list
/// reaches them: the last row asks for the next page, the same cursor the web
/// grid follows.
private struct PeopleSection: View {
    var analytics: AnalyticsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text("People")
                    .font(.headline)
                Spacer()
                if !analytics.sorts.isEmpty {
                    Menu {
                        ForEach(analytics.sorts) { sort in
                            Button(sort.label) {
                                Task { await analytics.choosePeople(sort: sort.id) }
                            }
                        }
                    } label: {
                        Text(selectedLabel)
                            .font(.footnote.weight(.medium))
                    }
                }
            }
            Text(caption)
                .font(.footnote)
                .foregroundStyle(.secondary)

            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(analytics.people) { person in
                    PersonRow(person: person)
                        .task {
                            if person.id == analytics.people.last?.id {
                                await analytics.loadMorePeople()
                            }
                        }
                }
                if let peopleError = analytics.peopleError {
                    Text(peopleError)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 12)
                } else if analytics.isLoadingPeople {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
            }
            .padding(.top, 8)
        }
        .padding(.vertical, 20)
        // The refresh that drew the charts is already fetching the first page;
        // this asks only when the section came up to an empty list.
        .task { if analytics.people.isEmpty { await analytics.loadMorePeople() } }
    }

    private var selectedLabel: String {
        analytics.sorts.first { $0.id == analytics.sort }?.label ?? String(localized: "Sort")
    }

    private var caption: String {
        guard analytics.peopleTotal > 0 else { return String(localized: "Accounts in rank order") }
        return String(localized: "\(analytics.people.count.formatted()) of \(analytics.peopleTotal.formatted()) accounts")
    }
}

private struct PersonRow: View {
    let person: AnalyticsUsersPage.Person

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(person.email)
                    .font(.subheadline)
                    .lineLimit(1)
                if person.superUser == true {
                    Text("su")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 4))
                }
            }
            Text(sub)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
    }

    private var sub: String {
        var parts = [
            person.activeDays == 0
                ? String(localized: "no activity")
                : String(localized: "\(person.activeDays) active days"),
            String(localized: "joined \(joined)"),
            usd(person.balanceMicros),
        ]
        if let funded = person.fundedMicros {
            parts.append(String(localized: "paid \(usd(funded))"))
        }
        return parts.joined(separator: " · ")
    }

    private func usd(_ micros: String) -> String {
        dollars((Double(micros) ?? 0) / 1_000_000)
    }

    private var joined: String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = iso.date(from: person.registeredAt) ?? ISO8601DateFormatter().date(from: person.registeredAt)
        return date?.formatted(.dateTime.month(.abbreviated).day()) ?? String(person.registeredAt.prefix(10))
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

// The charts' series names, read by the legend and matched by the color scale.
private let activeSeries = String(localized: "Active")
private let workingSeries = String(localized: "Working")
private let topUpsSeries = String(localized: "Top-ups")

private struct ActiveChart: View {
    let points: [AnalyticsSummary.DayPoint]

    var body: some View {
        Chart {
            ForEach(points.filter { $0.active != nil }) { point in
                LineMark(
                    x: .value("Day", point.day, unit: .day),
                    y: .value("Users", point.active ?? 0)
                )
                .foregroundStyle(by: .value("Series", activeSeries))
                .interpolationMethod(.monotone)
            }
            ForEach(points.filter { $0.working != nil }) { point in
                LineMark(
                    x: .value("Day", point.day, unit: .day),
                    y: .value("Users", point.working ?? 0)
                )
                .foregroundStyle(by: .value("Series", workingSeries))
                .interpolationMethod(.monotone)
            }
        }
        .chartForegroundStyleScale([activeSeries: Color.accentBlue, workingSeries: workingPurple])
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
    let points: [AnalyticsSummary.RevenuePoint]

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
                .foregroundStyle(by: .value("Series", topUpsSeries))
            }
        }
        .chartForegroundStyleScale(["Pro": Color.accentBlue, topUpsSeries: workingPurple])
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
