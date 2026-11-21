import Charts
import SwiftUI

extension Color {
  static let ledgerGreen = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 0.57, green: 0.84, blue: 0.69, alpha: 1)
        : UIColor(red: 0.08, green: 0.36, blue: 0.25, alpha: 1)
    })
  static let ledgerRust = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 1, green: 0.66, blue: 0.49, alpha: 1)
        : UIColor(red: 0.62, green: 0.25, blue: 0.13, alpha: 1)
    })
}
func dateKey(_ date: Date) -> String {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.calendar = Calendar(identifier: .gregorian)
  formatter.dateFormat = "yyyy-MM-dd"
  return formatter.string(from: date)
}
func money(_ cents: Int, _ currency: String) -> String {
  (Decimal(cents) / 100).formatted(.currency(code: currency))
}
struct ItemPage<T: Decodable>: Decodable {
  let items: [T]
  let total: Int
}
struct CashMonth: Decodable {
  let income: Int
  let expenses: Int
}
struct CashGroup: Decodable {
  let income: Int
  let expenses: Int
  let net: Int
  let months: [String: CashMonth]
}
struct CashReport: Decodable { let groups: [String: CashGroup] }
struct LedgerEntry: Decodable, Identifiable {
  let id: String, posted: String, description: String, currency: String, amount: Int
  let category_name: String?, account_name: String?
}
enum ReviewPeriod: String, CaseIterable, Identifiable {
  case year = "Year to date"
  case quarter = "This quarter"
  case month = "This month"
  case previous = "Last year"
  var id: Self { self }
  var bounds: (Date, Date) {
    let cal = Calendar(identifier: .gregorian)
    let now = Date()
    let year = cal.dateInterval(of: .year, for: now)!.start
    let month = cal.dateInterval(of: .month, for: now)!.start
    switch self {
    case .year: return (year, now)
    case .month: return (month, now)
    case .quarter:
      return (
        cal.date(
          byAdding: .month, value: -((cal.component(.month, from: now) - 1) % 3), to: month)!, now
      )
    case .previous:
      return (
        cal.date(byAdding: .year, value: -1, to: year)!,
        cal.date(byAdding: .day, value: -1, to: year)!
      )
    }
  }
}
struct CashPoint: Identifiable {
  let id: String, month: String, income: Int, expenses: Int
}
private func points(_ group: CashGroup, period: ReviewPeriod) -> [CashPoint] {
  let cal = Calendar(identifier: .gregorian)
  let bounds = period.bounds
  var month = cal.dateInterval(of: .month, for: bounds.0)!.start
  var result: [CashPoint] = []
  while month <= bounds.1 {
    let key = String(dateKey(month).prefix(7))
    let value = group.months[key]
    result.append(
      CashPoint(
        id: key, month: month.formatted(.dateTime.month(.abbreviated)), income: value?.income ?? 0,
        expenses: value?.expenses ?? 0))
    month = cal.date(byAdding: .month, value: 1, to: month)!
  }
  return result
}
struct OverviewScreen: View {
  @EnvironmentObject private var session: WorkspaceSession
  @ViewState private var period: ReviewPeriod = .year
  @ViewState private var currency = "USD"
  @ViewState private var report: CashReport?
  @ViewState private var message: String?
  var body: some View {
    List {
      Section {
        Picker("Period", selection: $period) {
          ForEach(ReviewPeriod.allCases) { Text($0.rawValue).tag($0) }
        }
        if let groups = report?.groups, groups.count > 1 {
          Picker("Currency", selection: $currency) {
            ForEach(groups.keys.sorted(), id: \.self) { Text($0).tag($0) }
          }
        }
      }
      if let message {
        Section { RetryRow(message: message) { await load() } }
      } else if let report {
        if let group = report.groups[currency] {
          CashSummary(group: group, currency: currency, rows: points(group, period: period))
          Section {
            NavigationLink("View transactions") {
              TransactionsScreen(period: period, currency: currency)
            }
          }
        } else {
          ContentUnavailableView(
            "No cash flow this period", systemImage: "chart.xyaxis.line",
            description: Text("Choose another period to review your books."))
        }
      } else {
        ProgressView("Loading cash flow")
      }
    }
    .navigationTitle("Overview").refreshable { await load() }.task(id: period) { await load() }
  }
  private func load() async {
    let requested = period
    let range = requested.bounds
    message = nil
    report = nil
    do {
      let value: CashReport = try await session.get(
        "api/report",
        query: [
          .init(name: "from", value: dateKey(range.0)), .init(name: "to", value: dateKey(range.1)),
        ])
      guard !Task.isCancelled, requested == period else { return }
      if value.groups[currency] == nil { currency = value.groups.keys.sorted().first ?? "USD" }
      report = value
    } catch { if !Task.isCancelled && requested == period { message = error.localizedDescription } }
  }
}
struct CashSummary: View {
  let group: CashGroup, currency: String, rows: [CashPoint]
  @ViewState private var showFigures = false
  @Environment(\.dynamicTypeSize) private var size
  var body: some View {
    Section {
      VStack(alignment: .leading, spacing: 8) {
        Text("Net cash flow · " + currency).font(.subheadline).foregroundStyle(.secondary)
        Text(money(group.net, currency)).font(.largeTitle.weight(.semibold)).monospacedDigit()
      }.accessibilityElement(children: .combine)
      LabeledContent("Income", value: money(group.income, currency))
      LabeledContent("Expenses", value: money(group.expenses, currency))
    }
    Section("Cash flow by month") {
      Picker("Chart display", selection: $showFigures) {
        Text("Chart").tag(false)
        Text("Figures").tag(true)
      }.pickerStyle(.segmented)
      if showFigures {
        ForEach(rows) { row in
          VStack(alignment: .leading, spacing: 4) {
            Text(row.month).font(.headline)
            Text("Income " + money(row.income, currency))
            Text("Expenses " + money(row.expenses, currency))
          }.accessibilityElement(children: .combine)
        }
      } else {
        Chart(rows) { row in
          LineMark(
            x: .value("Month", row.month), y: .value("Amount", Double(row.income) / 100),
            series: .value("Series", "Income")
          )
          .foregroundStyle(by: .value("Category", "Income")).symbol(.circle)
          LineMark(
            x: .value("Month", row.month), y: .value("Amount", Double(row.expenses) / 100),
            series: .value("Series", "Expenses")
          )
          .foregroundStyle(by: .value("Category", "Expenses")).symbol(.diamond).lineStyle(
            .init(lineWidth: 2, dash: [4, 3]))
        }
        .chartForegroundStyleScale(["Income": Color.ledgerGreen, "Expenses": Color.ledgerRust])
        .chartXAxis {
          AxisMarks(
            values: rows.enumerated().compactMap {
              $0.offset % (rows.count > 6 ? 3 : 1) == 0 ? $0.element.month : nil
            })
        }
        .frame(height: size.isAccessibilitySize ? 220 : 180)
        .accessibilityLabel("Monthly income and expenses in " + currency)
      }
    }
  }
}
struct RetryRow: View {
  let message: String, retry: () async -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(message)
      Button("Try again") { Task { await retry() } }
    }
  }
}
struct TransactionsScreen: View {
  @EnvironmentObject private var session: WorkspaceSession
  var period: ReviewPeriod? = nil
  var currency: String? = nil
  @ViewState private var rows: [LedgerEntry] = []
  @ViewState private var search = ""
  @ViewState private var page = 0
  @ViewState private var total = 0
  @ViewState private var busy = false
  @ViewState private var message: String?
  @ViewState private var requestID = UUID()
  var body: some View {
    List {
      ForEach(rows) { entry in
        NavigationLink {
          List {
            LabeledContent("Amount", value: money(entry.amount, entry.currency))
            LabeledContent("Currency", value: entry.currency)
            LabeledContent("Date", value: entry.posted)
            LabeledContent("Account", value: entry.account_name ?? "—")
            LabeledContent("Category", value: entry.category_name ?? "Uncategorized")
          }.navigationTitle(entry.description)
        } label: {
          VStack(alignment: .leading, spacing: 6) {
            Text(entry.description).font(.headline)
            ViewThatFits(in: .horizontal) {
              HStack {
                Text(entry.posted)
                Spacer()
                Text(money(entry.amount, entry.currency)).monospacedDigit()
              }
              VStack(alignment: .leading) {
                Text(entry.posted)
                Text(money(entry.amount, entry.currency))
              }
            }.font(.subheadline)
          }.accessibilityElement(children: .combine)
        }
      }
      if let message {
        RetryRow(message: message) { await load(next: page + 1) }
      } else if busy {
        ProgressView("Loading transactions")
      } else if rows.isEmpty {
        ContentUnavailableView(
          "No transactions", systemImage: "list.bullet.rectangle",
          description: Text("Transactions matching this view appear here."))
      } else if rows.count < total {
        Button("Load more transactions") { Task { await load(next: page + 1) } }
      }
    }
    .navigationTitle("Transactions").searchable(text: $search, prompt: "Search transactions")
    .refreshable { await load(next: 1) }
    .task(id: search) {
      if !search.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
      if !Task.isCancelled { await load(next: 1) }
    }
  }
  private func load(next: Int) async {
    let key = UUID()
    requestID = key
    if next == 1 {
      rows = []
      page = 0
      total = 0
    }
    busy = true
    message = nil
    var query = [
      URLQueryItem(name: "limit", value: "50"), .init(name: "page", value: String(next)),
      .init(name: "q", value: search),
    ]
    if let period {
      let range = period.bounds
      query += [
        .init(name: "from", value: dateKey(range.0)), .init(name: "to", value: dateKey(range.1)),
        .init(name: "pending", value: "0"),
      ]
    }
    if let currency { query.append(.init(name: "currency", value: currency)) }
    do {
      let result: ItemPage<LedgerEntry> = try await session.get("api/transactions", query: query)
      guard requestID == key, !Task.isCancelled else { return }
      rows += result.items
      total = result.total
      page = next
    } catch { if requestID == key && !Task.isCancelled { message = error.localizedDescription } }
    if requestID == key { busy = false }
  }
}

#if DEBUG
  struct OverviewPreview: PreviewProvider {
    static var previews: some View {
      let months = [
        CashPoint(id: "2026-01", month: "Jan", income: 420000, expenses: 100000),
        CashPoint(id: "2026-02", month: "Feb", income: 360000, expenses: 125000),
        CashPoint(id: "2026-03", month: "Mar", income: 505000, expenses: 105000),
      ]
      let group = CashGroup(income: 1_285_000, expenses: 330000, net: 955000, months: [:])
      return NavigationStack {
        List { CashSummary(group: group, currency: "USD", rows: months) }.navigationTitle(
          "Overview")
      }
    }
  }
#endif
