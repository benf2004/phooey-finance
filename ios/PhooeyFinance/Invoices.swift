import CoreFoundation
import PDFKit
import SwiftUI
import UniformTypeIdentifiers

// Carry the complete document through a mobile edit, including branding, tax and custom fields.
indirect enum InvoiceValue: Codable, Equatable {
  case text(String)
  case number(Decimal)
  case object([String: Self])
  case array([Self])
  case flag(Bool)
  case null

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let s = try? c.decode(String.self) {
      self = .text(s)
    } else if let b = try? c.decode(Bool.self) {
      self = .flag(b)
    } else if let n = try? c.decode(Decimal.self) {
      self = .number(n)
    } else if let a = try? c.decode([Self].self) {
      self = .array(a)
    } else {
      self = .object(try c.decode([String: Self].self))
    }
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .text(let s): try c.encode(s)
    case .number(let n): try c.encode(n)
    case .flag(let b): try c.encode(b)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    case .null: try c.encodeNil()
    }
  }
  var text: String {
    if case .text(let s) = self { return s }
    return ""
  }
  var object: [String: Self] {
    if case .object(let o) = self { return o }
    return [:]
  }
  var array: [Self] {
    if case .array(let a) = self { return a }
    return []
  }
}
typealias InvoiceFields = [String: InvoiceValue]
struct NativeInvoice: Decodable, Identifiable {
  let id: String, number: String, status: String, revision: Int, document: InvoiceFields
  let archivedAt: String?
  let totals: Totals
  struct Totals: Decodable { let subtotal: Int, total: Int, balanceDue: Int }
  var currency: String { document["currency"]?.text ?? "USD" }
  var customer: String {
    let name = document["billTo"]?.object["name"]?.text ?? ""
    return name.isEmpty ? "Unassigned customer" : name
  }
  var title: String { number.isEmpty ? "Draft invoice" : number }
}
private let invoiceAPI = "invoicer/api/v1/"
private struct EditorSelection: Identifiable {
  let id = UUID(), invoice: NativeInvoice?, document: InvoiceFields
}
private let emptyLine = InvoiceValue.object([
  "description": .text(""), "quantity": .text("1"), "rate": .text("0"),
])

struct InvoiceListScreen: View {
  @EnvironmentObject private var session: WorkspaceSession
  @ViewState private var invoices: [NativeInvoice] = []
  @ViewState private var filter = "all"
  @ViewState private var query = ""
  @ViewState private var page = 0
  @ViewState private var total = 0
  @ViewState private var busy = false
  @ViewState private var message: String?
  @ViewState private var editor: EditorSelection?
  @ViewState private var requestID = UUID()
  @ViewState private var preparing = false
  var body: some View {
    List {
      Picker("Status", selection: $filter) {
        ForEach(["all", "draft", "issued", "paid", "overdue", "void"], id: \.self) {
          Text($0.capitalized).tag($0)
        }
      }
      ForEach(invoices) { invoice in
        Button {
          editor = EditorSelection(invoice: invoice, document: invoice.document)
        } label: {
          VStack(alignment: .leading, spacing: 5) {
            Text(invoice.customer).font(.headline).foregroundStyle(.primary)
            Text([invoice.title, invoice.status.capitalized].joined(separator: " · ")).font(
              .subheadline
            ).foregroundStyle(.secondary)
            Text(invoiceAmount(invoice.totals.balanceDue, invoice.currency) + " due").font(
              .subheadline
            ).monospacedDigit()
          }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityElement(children: .combine)
      }
      if let message {
        RetryRow(message: message) { await load(next: page + 1) }
      } else if busy || preparing {
        ProgressView(preparing ? "Preparing draft" : "Loading invoices")
      } else if invoices.isEmpty {
        ContentUnavailableView(
          "No matching invoices", systemImage: "doc.text",
          description: Text("Create a draft or change the search and status."))
      } else if invoices.count < total {
        Button("Load more invoices") { Task { await load(next: page + 1) } }
      }
    }
    .navigationTitle("Invoices")
    .searchable(text: $query, prompt: "Customer or invoice number")
    .toolbar {
      Button {
        Task { await newDraft() }
      } label: {
        Label("New invoice", systemImage: "plus")
      }.disabled(preparing)
    }
    .refreshable { await load(next: 1) }
    .task(id: [query, filter]) {
      if !query.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
      if !Task.isCancelled { await load(next: 1) }
    }
    .sheet(item: $editor) { selection in
      NativeInvoiceEditor(record: selection.invoice, document: selection.document) { result in
        if let i = invoices.firstIndex(where: { $0.id == result.id }) { invoices[i] = result }
        Task { await load(next: 1) }
      }
    }
  }
  private func newDraft() async {
    preparing = true
    message = nil
    defer { preparing = false }
    do {
      struct SettingsResult: Decodable { let settings: InvoiceFields }
      let response: SettingsResult = try await session.get(invoiceAPI + "settings")
      let settings = response.settings
      let draft: InvoiceFields = [
        "business": settings["business"] ?? .object([:]), "billTo": .object([:]),
        "currency": settings["currency"] ?? .text("USD"),
        "locale": settings["locale"] ?? .text("en-US"),
        "date": .text(dateKey(Date())), "items": .array([emptyLine]),
      ]
      editor = EditorSelection(invoice: nil, document: draft)
    } catch { message = error.localizedDescription }
  }
  private func load(next: Int) async {
    let key = UUID()
    requestID = key
    if next == 1 {
      invoices = []
      total = 0
      page = 0
    }
    busy = true
    message = nil
    do {
      let result: ItemPage<NativeInvoice> = try await session.get(
        invoiceAPI + "invoices",
        query: [
          .init(name: "limit", value: "40"), .init(name: "page", value: String(next)),
          .init(name: "q", value: query), .init(name: "status", value: filter),
        ])
      guard requestID == key, !Task.isCancelled else { return }
      invoices += result.items
      page = next
      total = result.total
    } catch { if requestID == key && !Task.isCancelled { message = error.localizedDescription } }
    if requestID == key { busy = false }
  }
}

private func invoiceAmount(_ minor: Int, _ currency: String) -> String {
  decimalAmount(minor: Decimal(minor), currency: currency).formatted(.currency(code: currency))

}

private func invoiceDigits(_ currency: String) -> Int {
  var digits: Int32 = 2
  _ = CFNumberFormatterGetDecimalInfoForCurrencyCode(currency as CFString, &digits, nil)
  return Int(digits)
}
private func decimalAmount(minor: Decimal, currency: String) -> Decimal {
  minor / pow(Decimal(10), invoiceDigits(currency))
}
private func balanceOf(_ document: InvoiceFields) -> Decimal? {
  let currency = document["currency"]?.text ?? "USD"
  let scale = invoiceDigits(currency)
  func round(_ value: Decimal) -> Decimal {
    var input = value
    var output = Decimal()
    NSDecimalRound(&output, &input, scale, .plain)
    return output
  }
  func number(_ text: String) -> Decimal? {
    guard text.range(of: #"^\d{1,12}(\.\d{1,6})?$"#, options: .regularExpression) != nil else {
      return nil
    }
    return Decimal(string: text, locale: Locale(identifier: "en_US_POSIX"))
  }
  func adjustment(_ key: String, on base: Decimal) -> Decimal? {
    guard let field = document[key]?.object else { return 0 }
    guard let value = number(field["value"]?.text ?? "0") else { return nil }
    if field["type"]?.text == "fixed" { return round(value) }
    return value <= 100 ? round(base * value / 100) : nil
  }
  var subtotal = Decimal.zero
  for line in document["items"]?.array ?? [] {
    guard let qty = number(line.object["quantity"]?.text ?? ""), qty > 0,
      let rate = number(line.object["rate"]?.text ?? "")
    else { return nil }
    subtotal += round(qty * rate)
  }
  guard let discount = adjustment("discount", on: subtotal), discount <= subtotal,
    let tax = adjustment("tax", on: subtotal - discount),
    let shipping = number(document["shipping"]?.text ?? "0"),
    let paid = number(document["amountPaid"]?.text ?? "0")
  else { return nil }
  let balance = subtotal - discount + tax + round(shipping) - round(paid)
  return balance >= 0 ? balance : nil
}
private struct PDFExport: FileDocument {
  static let readableContentTypes: [UTType] = [.pdf]
  let data: Data
  init(data: Data) { self.data = data }
  init(configuration: ReadConfiguration) throws {
    guard let data = configuration.file.regularFileContents else {
      throw CocoaError(.fileReadCorruptFile)
    }
    self.data = data
  }
  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: data)
  }
}
private struct PreviewPDF: Identifiable {
  let id = UUID(), data: Data
}
private struct PDFPreviewSheet: View {
  let data: Data
  let number: String
  @Environment(\.dismiss) private var dismiss
  @ViewState private var exporting = false
  @ViewState private var exportError: String?
  var body: some View {
    NavigationStack {
      PDFCanvas(data: data).navigationTitle("Invoice preview").navigationBarTitleDisplayMode(
        .inline
      )
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
        ToolbarItem(placement: .primaryAction) {
          Button("Save PDF", systemImage: "square.and.arrow.down") { exporting = true }
        }
      }
      .fileExporter(
        isPresented: $exporting, document: PDFExport(data: data), contentType: .pdf,
        defaultFilename: number.isEmpty ? "Invoice" : number
      ) { result in
        if case .failure(let error) = result { exportError = error.localizedDescription }
      }
      .alert(
        "PDF export",
        isPresented: Binding(get: { exportError != nil }, set: { if !$0 { exportError = nil } })
      ) {
        Button("OK") { exportError = nil }
      } message: {
        Text(exportError ?? "")
      }
    }
  }
}
private struct PDFCanvas: UIViewRepresentable {
  let data: Data
  func makeUIView(context: Context) -> PDFView {
    let view = PDFView()
    view.autoScales = true
    view.document = PDFDocument(data: data)
    return view
  }
  func updateUIView(_ view: PDFView, context: Context) {}
}
private struct NativeInvoiceEditor: View {
  @EnvironmentObject private var session: WorkspaceSession
  @Environment(\.dismiss) private var dismiss
  @ViewState private var record: NativeInvoice?
  @ViewState private var document: InvoiceFields
  @ViewState private var original: InvoiceFields
  @ViewState private var saveKey = UUID().uuidString
  @ViewState private var pendingCreate: Data?
  @ViewState private var working = false
  @ViewState private var confirmDiscard = false
  @ViewState private var confirmIssue = false
  @ViewState private var conflict = false
  @ViewState private var confirmReload = false
  @ViewState private var message: String?
  @ViewState private var preview: PreviewPDF?
  let didSave: (NativeInvoice) -> Void
  init(record: NativeInvoice?, document: InvoiceFields, didSave: @escaping (NativeInvoice) -> Void)
  {
    _record = State(initialValue: record)
    _document = State(initialValue: document)
    _original = State(initialValue: document)
    self.didSave = didSave
  }
  private var dirty: Bool { original != document }
  private var editable: Bool {
    record == nil || (record?.status == "draft" && record?.archivedAt == nil)
  }
  private var lines: [InvoiceValue] { document["items"]?.array ?? [] }
  private func field(_ key: String) -> Binding<String> {
    Binding(get: { document[key]?.text ?? "" }, set: { document[key] = .text($0) })
  }
  private func party(_ group: String, _ key: String) -> Binding<String> {
    Binding(
      get: { document[group]?.object[key]?.text ?? "" },
      set: { value in
        var fields = document[group]?.object ?? [:]
        fields[key] = .text(value)
        document[group] = .object(fields)
      })
  }
  private func item(_ i: Int, _ key: String) -> Binding<String> {
    Binding(
      get: { lines.indices.contains(i) ? lines[i].object[key]?.text ?? "" : "" },
      set: { value in
        guard lines.indices.contains(i) else { return }
        var values = lines
        var row = values[i].object
        let decimalSeparator = Locale.current.decimalSeparator ?? "."
        let stored =
          ["quantity", "rate"].contains(key)
          ? value.replacingOccurrences(of: decimalSeparator, with: ".") : value
        row[key] = .text(stored)
        values[i] = .object(row)
        document["items"] = .array(values)
      })
  }
  private func partySection(_ title: String, _ group: String) -> some View {
    Section(title) {
      namedField("Name", party(group, "name"))
      DisclosureGroup("Contact details") {
        namedField("Email", party(group, "email")).keyboardType(.emailAddress)
          .textInputAutocapitalization(.never)
        namedField("Address", party(group, "address"))
        namedField("Phone", party(group, "phone")).keyboardType(.phonePad)
        namedField("Tax ID", party(group, "taxId"))
      }
    }
  }
  @ViewBuilder
  private func namedField(_ title: String, _ value: Binding<String>) -> some View {
    if editable {
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
        TextField(title, text: value, axis: .vertical).accessibilityLabel(title)
      }
    } else if !value.wrappedValue.isEmpty {
      LabeledContent(title, value: value.wrappedValue)
    }
  }
  @ViewBuilder
  private func dateField(_ title: String, _ key: String) -> some View {
    if !editable {
      LabeledContent(title, value: document[key]?.text ?? "—")
    } else {
      DatePicker(
        title,
        selection: Binding(
          get: {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy-MM-dd"
            return formatter.date(from: document[key]?.text ?? "") ?? Date()
          }, set: { document[key] = .text(dateKey($0)) }), displayedComponents: .date)
    }
  }
  var body: some View {
    NavigationStack {
      Form {
        if let message {
          Section { Text(message).accessibilityLabel("Invoice message. " + message) }
        }
        if conflict && record != nil {
          Button("Reload saved invoice") { confirmReload = true }
        }
        Group {
          Section {
            HStack {
              Text("Invoice").font(.largeTitle.weight(.semibold)).fontDesign(.serif)
              Spacer()
              Text((record?.status ?? "draft").capitalized).font(.subheadline).foregroundStyle(
                .secondary)
            }
            namedField("Invoice number", field("invoiceNumber"))
            dateField("Invoice date", "date")
            if !(document["dueDate"]?.text ?? "").isEmpty {
              dateField("Due date", "dueDate")
              if editable { Button("Remove due date") { document["dueDate"] = .text("") } }
            } else if editable {
              Button("Add due date") { document["dueDate"] = .text(dateKey(Date())) }
            }
            LabeledContent("Currency", value: document["currency"]?.text ?? "USD")
          }
          partySection("From", "business")
          partySection("Bill to", "billTo")
          Section("Line items") {
            ForEach(lines.indices, id: \.self) { i in
              VStack(alignment: .leading, spacing: 10) {
                namedField("Description", item(i, "description"))
                namedField("Quantity", item(i, "quantity")).keyboardType(.decimalPad)
                namedField("Rate", item(i, "rate")).keyboardType(.decimalPad)
                if editable && lines.count > 1 {
                  Button("Remove item", role: .destructive) {
                    var values = lines
                    values.remove(at: i)
                    document["items"] = .array(values)
                  }.buttonStyle(.borderless)
                }
              }.padding(.vertical, 4)
            }
            if editable && lines.count < 200 {
              Button("Add line item", systemImage: "plus") {
                document["items"] = .array(lines + [emptyLine])
              }
            }
          }
          Section {
            namedField("Notes", field("notes"))
            namedField("Payment terms", field("paymentTerms"))
          }
        }.disabled(working)
        if let record, !dirty {
          Section {
            LabeledContent("Total", value: invoiceAmount(record.totals.total, record.currency))
            LabeledContent(
              "Balance due", value: invoiceAmount(record.totals.balanceDue, record.currency))
          }
        }
        if record == nil || dirty {
          Section {
            LabeledContent(
              "Balance due",
              value: balanceOf(document)?.formatted(
                .currency(code: document["currency"]?.text ?? "USD")) ?? "Enter valid amounts")
          }
        }
        if session.expired {
          Button("Sign in to continue") { session.signIn() }.disabled(session.busy)
          if let signInMessage = session.message { Text(signInMessage) }
        }
        Section {
          Button("Preview PDF", systemImage: "doc.richtext") { Task { await openPDF() } }
          if editable { Button("Issue invoice") { confirmIssue = true } }
        }.disabled(working)
        if working { ProgressView("Working") }
      }
      .navigationTitle(record?.title ?? "New invoice").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { if dirty { confirmDiscard = true } else { dismiss() } }.disabled(
            working)
        }
        if editable {
          ToolbarItem(placement: .confirmationAction) {
            Button("Save draft") { Task { await save(issue: false) } }.disabled(
              working || (record != nil && !dirty))
          }
        }
      }
      .interactiveDismissDisabled(dirty || working)
      .confirmationDialog(
        "Discard unsaved edits?", isPresented: $confirmDiscard, titleVisibility: .visible
      ) {
        Button("Discard changes", role: .destructive) { dismiss() }
        Button("Keep editing", role: .cancel) {}
      }
      .confirmationDialog(
        "Replace your edits with the latest saved invoice?", isPresented: $confirmReload,
        titleVisibility: .visible
      ) {
        Button("Reload invoice", role: .destructive) { Task { await reload() } }
      }
      .confirmationDialog(
        "Issue this invoice?", isPresented: $confirmIssue, titleVisibility: .visible
      ) {
        Button("Issue invoice") { Task { await save(issue: true) } }
      } message: {
        Text("Issuing locks the invoice details. You can review the PDF first.")
      }
      .sheet(item: $preview) { value in
        PDFPreviewSheet(data: value.data, number: record?.number ?? "")
      }
    }
  }
  private func encoded(_ fields: InvoiceFields) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return try encoder.encode(fields)
  }
  private func reload() async {
    guard let record, !working else { return }
    working = true
    defer { working = false }
    do {
      let current: NativeInvoice = try await session.get(invoiceAPI + "invoices/" + record.id)
      self.record = current
      document = current.document
      original = current.document
      conflict = false
      message = nil
      didSave(current)
    } catch { message = error.localizedDescription }
  }
  private func save(issue: Bool) async {
    guard !working else { return }
    working = true
    message = nil
    defer { working = false }
    do {
      var fields = document
      var result: NativeInvoice
      if record == nil, let prior = pendingCreate {
        var attempted = fields
        attempted["status"] = .text(issue ? "issued" : "draft")
        if try encoded(attempted) != prior {
          let bytes = try await session.data(
            invoiceAPI + "invoices", method: "POST", body: prior, key: saveKey)
          let recovered = try JSONDecoder().decode(NativeInvoice.self, from: bytes)
          record = recovered
          original = recovered.document
          pendingCreate = nil
          didSave(recovered)
          if recovered.status != "draft" {
            document = recovered.document
            message = "The earlier request issued this invoice. Its saved details are shown."
            return
          }
        }
      }
      if let saved = record {
        if dirty {
          fields["revision"] = .number(Decimal(saved.revision))
          result = try JSONDecoder().decode(
            NativeInvoice.self,
            from: await session.data(
              invoiceAPI + "invoices/" + saved.id, method: "PUT", body: encoded(fields)))
        } else {
          result = saved
        }
      } else {
        fields["status"] = .text(issue ? "issued" : "draft")
        let payload = try encoded(fields)
        pendingCreate = payload
        result = try JSONDecoder().decode(
          NativeInvoice.self,
          from: await session.data(
            invoiceAPI + "invoices", method: "POST", body: payload, key: saveKey))
        pendingCreate = nil
      }
      func accept(_ result: NativeInvoice) {
        record = result
        document = result.document
        original = result.document
        didSave(result)
      }
      accept(result)
      if issue && result.status == "draft" {
        let body = try encoded(["revision": .number(Decimal(result.revision))])
        result = try JSONDecoder().decode(
          NativeInvoice.self,
          from: await session.data(
            invoiceAPI + "invoices/" + result.id + "/issue", method: "POST", body: body))
        accept(result)
      }
      message = issue ? "Invoice issued." : "Draft saved."
    } catch {
      if let status = (error as? WorkspaceError)?.status, (400..<500).contains(status) {
        conflict = status == 409 && record != nil
        pendingCreate = nil
        saveKey = UUID().uuidString
      }
      message = error.localizedDescription
    }
  }
  private func openPDF() async {
    guard !working else { return }
    working = true
    message = nil
    defer { working = false }
    do {
      let bytes: Data
      if let record, !dirty {
        bytes = try await session.data(invoiceAPI + "invoices/" + record.id + "/pdf")
      } else {
        bytes = try await session.data(
          invoiceAPI + "render", method: "POST", body: encoded(document))
      }
      guard let pdf = PDFDocument(data: bytes), pdf.pageCount > 0 else {
        throw WorkspaceError("The PDF could not be opened.")
      }
      preview = PreviewPDF(data: bytes)
    } catch { message = error.localizedDescription }
  }
}

#if DEBUG
  struct InvoiceEditorPreview: PreviewProvider {
    static var previews: some View {
      let fields: InvoiceFields = [
        "invoiceNumber": .text("1042"), "date": .text("2026-11-21"), "dueDate": .text("2026-12-21"),
        "currency": .text("USD"), "business": .object(["name": .text("Finch Studio")]),
        "billTo": .object(["name": .text("Studio North")]),
        "items": .array([
          .object([
            "description": .text("Website design"), "quantity": .text("8"), "rate": .text("100"),
          ])
        ]),
      ]
      return NativeInvoiceEditor(record: nil, document: fields) { _ in }.environmentObject(
        WorkspaceSession(restoreSavedWorkspace: false))
    }
  }
#endif
