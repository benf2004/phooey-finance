import AuthenticationServices
import CryptoKit
import Security
import SwiftUI

// Use the DynamicProperty wrapper supported by the iOS 17 deployment target.
typealias ViewState<Value> = SwiftUI.State<Value>

@main
struct PhooeyFinanceApp: App {
  var body: some Scene {
    WindowGroup { FinanceWorkspace() }
  }
}

let portal = URL(string: "https://finance.phooey.foo")!

private func base64URL(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
private func randomSecret() throws -> String {
  var bytes = [UInt8](repeating: 0, count: 32)
  guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
    throw URLError(.unknown)
  }
  return base64URL(Data(bytes))
}

@MainActor
final class WorkspaceSession: NSObject, ObservableObject,
  ASWebAuthenticationPresentationContextProviding
{
  @Published var origin: URL?
  @Published var expired = false
  @Published var busy = false
  @Published var message: String?
  private let transport: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = .shared
    config.urlCache = nil
    return URLSession(configuration: config)
  }()
  private var auth: ASWebAuthenticationSession?

  init(restoreSavedWorkspace: Bool = true) {
    super.init()
    guard restoreSavedWorkspace else { return }
    if let saved = UserDefaults.standard.url(forKey: "workspace"), saved.scheme == "https" {
      origin = saved
    }
  }
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
      ?? ASPresentationAnchor()
  }
  func signIn() {
    do {
      let verifier = try randomSecret()
      let state = try randomSecret()
      var url = URLComponents(
        url: portal.appendingPathComponent("cloud/mobile/start"), resolvingAgainstBaseURL: false)!
      url.queryItems = [
        URLQueryItem(
          name: "challenge", value: base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))),
        URLQueryItem(name: "state", value: state),
      ]
      busy = true
      message = nil
      auth = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: "phooeyfinance") {
        [weak self] callback, error in
        Task { @MainActor in
          guard let self else { return }
          defer {
            self.busy = false
            self.auth = nil
          }
          if let error {
            if (error as NSError).code != ASWebAuthenticationSessionError.canceledLogin.rawValue {
              self.message = error.localizedDescription
            }
            return
          }
          guard let callback, callback.host == "signin",
            let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
            parts.first(where: { $0.name == "state" })?.value == state,
            let code = parts.first(where: { $0.name == "code" })?.value
          else {
            self.message = "Sign-in expired. Please sign in again."
            return
          }
          do { try await self.redeem(code, verifier) } catch {
            self.message = error.localizedDescription
          }
        }
      }
      auth?.presentationContextProvider = self
      if auth?.start() != true {
        busy = false
        message = "Sign-in could not open. Try again."
      }
    } catch { message = error.localizedDescription }
  }
  private func post(_ url: URL, _ fields: [String: String]) async throws -> (Data, HTTPURLResponse)
  {
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(fields)
    let (data, response) = try await transport.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      throw URLError(.userAuthenticationRequired)
    }
    return (data, http)
  }
  private func redeem(_ code: String, _ verifier: String) async throws {
    struct Ticket: Decodable {
      let origin: URL
      let ticket: String
    }
    let (data, _) = try await post(
      portal.appendingPathComponent("cloud/mobile/exchange"), ["code": code, "verifier": verifier])
    let grant = try JSONDecoder().decode(Ticket.self, from: data)
    guard grant.origin.scheme == "https" else { throw URLError(.badServerResponse) }
    let (_, response) = try await post(
      grant.origin.appendingPathComponent("cloud/mobile/accept"), ["ticket": grant.ticket])
    guard let header = response.value(forHTTPHeaderField: "Set-Cookie"),
      let cookie = HTTPCookie.cookies(
        withResponseHeaderFields: ["Set-Cookie": header], for: grant.origin
      ).first,
      cookie.name == "__Host-phooey_dashboard"
    else { throw URLError(.userAuthenticationRequired) }
    HTTPCookieStorage.shared.setCookie(cookie)
    UserDefaults.standard.set(grant.origin, forKey: "workspace")
    origin = grant.origin
    expired = false
  }
  func data(
    _ path: String, query: [URLQueryItem] = [], method: String = "GET",
    body: Data? = nil, key: String? = nil
  ) async throws -> Data {
    guard let origin else { throw WorkspaceError("Sign in to open your workspace.") }
    var components = URLComponents(
      url: origin.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
    components.queryItems = query.isEmpty ? nil : query
    var request = URLRequest(url: components.url!, cachePolicy: .reloadIgnoringLocalCacheData)
    request.httpMethod = method
    request.httpBody = body
    if method != "GET" {
      request.setValue(
        origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
        forHTTPHeaderField: "Origin")
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
    let (data, response) = try await transport.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    if http.statusCode == 401 {
      expired = true
      throw WorkspaceError("Your session expired. Sign in to continue.")
    }
    guard (200..<300).contains(http.statusCode) else {
      let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      let nested = value?["error"] as? [String: Any]
      let detail = (nested?["details"] as? [[String: String]])?.first
      let reason = detail.map {
        [$0["path"], $0["message"]].compactMap { $0 }.joined(separator: " · ")
      }
      throw WorkspaceError(
        reason ?? nested?["message"] as? String ?? value?["error"] as? String
          ?? (http.statusCode == 402
            ? "Your subscription has ended."
            : "The workspace request failed (\(http.statusCode))."),
        status: http.statusCode)
    }
    return data
  }
  func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
    try JSONDecoder().decode(T.self, from: await data(path, query: query))
  }
  func signOut() async {
    do {
      _ = try await data("api/logout", method: "POST", body: Data("{}".utf8))
      clearLocalSession()
    } catch { message = error.localizedDescription }
  }
  func clearLocalSession() {
    if let origin {
      for cookie in HTTPCookieStorage.shared.cookies(for: origin) ?? []
      where cookie.name == "__Host-phooey_dashboard" {
        HTTPCookieStorage.shared.deleteCookie(cookie)
      }
    }
    UserDefaults.standard.removeObject(forKey: "workspace")
    origin = nil
    expired = false
    message = nil
  }
}

struct WorkspaceError: LocalizedError {
  let errorDescription: String?
  let status: Int?
  init(_ text: String, status: Int? = nil) {
    errorDescription = text
    self.status = status
  }
}

struct FinanceWorkspace: View {
  @StateObject private var session = WorkspaceSession()
  @ViewState private var confirmLogout = false
  var body: some View {
    Group {
      if let origin = session.origin {
        TabView {
          NavigationStack {
            OverviewScreen()
              .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                  Menu {
                    Link(
                      "Manage subscription",
                      destination: portal.appendingPathComponent("cloud/account"))
                    Button("Sign out everywhere", role: .destructive) { confirmLogout = true }
                  } label: {
                    Label("Account", systemImage: "person.crop.circle")
                  }
                }
              }
          }
          .tabItem { Label("Overview", systemImage: "chart.xyaxis.line") }
          NavigationStack { TransactionsScreen() }
            .tabItem { Label("Transactions", systemImage: "list.bullet.rectangle") }
          NavigationStack { InvoiceListScreen() }
            .tabItem { Label("Invoices", systemImage: "doc.text") }
        }
        .id(origin)
        .overlay { if session.expired { signInView } }
        .confirmationDialog(
          "Sign out of all Phooey sessions?", isPresented: $confirmLogout, titleVisibility: .visible
        ) {
          Button("Sign out everywhere", role: .destructive) { Task { await session.signOut() } }
        }
        .alert(
          "Workspace",
          isPresented: Binding(
            get: { session.message != nil && !session.expired },
            set: { if !$0 { session.message = nil } })
        ) {
          Button("OK") { session.message = nil }
        } message: {
          Text(session.message ?? "")
        }
      } else {
        signInView
      }
    }.environmentObject(session).tint(.ledgerGreen)
  }

  private var signInView: some View {
    VStack(alignment: .leading, spacing: 24) {
      VStack(alignment: .leading, spacing: 0) {
        Image("PhooeyMark").resizable().scaledToFit().frame(width: 170).accessibilityHidden(true)
        Text("finance").font(.largeTitle.weight(.semibold))
      }.accessibilityElement(children: .ignore).accessibilityLabel("phooey! finance")
      Text(
        session.expired
          ? "Your session expired. Sign in to continue." : "Your books and invoices, together."
      ).font(.title3).foregroundStyle(.secondary)
      if let message = session.message { Text(message).foregroundStyle(.primary) }
      Button(action: session.signIn) {
        if session.busy {
          ProgressView().accessibilityLabel("Signing in")
        } else {
          Text("Sign in").frame(minWidth: 110)
        }
      }.buttonStyle(.borderedProminent).controlSize(.large).disabled(session.busy)
      if session.expired {
        Button("Return to sign-in", role: .cancel) { session.clearLocalSession() }
      }
    }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      .background(Color(uiColor: .systemBackground))
  }
}
