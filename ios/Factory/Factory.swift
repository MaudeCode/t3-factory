import AuthenticationServices
import CryptoKit
import SwiftUI
import UIKit
import WebKit

@main
final class FactoryApp: UIResponder, UIApplicationDelegate {}

final class FactoryScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    static let appearanceKey = "factoryWebAppearance"
    static let canvas = UIColor { traits in
        traits.userInterfaceStyle == .dark ? (UIColor(named: "LaunchBackground") ?? .black) : .systemBackground.resolvedColor(with: traits)
    }

    static func style(for appearance: String?) -> UIUserInterfaceStyle {
        switch appearance {
        case "system": .unspecified
        case "light": .light
        default: .dark
        }
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = Self.style(for: UserDefaults.standard.string(forKey: Self.appearanceKey))
        window.backgroundColor = Self.canvas
        let controller = FactoryController()
        if let link = options.userActivities.compactMap(Self.webLink).first ?? options.urlContexts.first?.url {
            controller.openLink(link)
        }
        window.rootViewController = controller
        self.window = window
        window.makeKeyAndVisible()
    }

    private static func webLink(_ activity: NSUserActivity) -> URL? {
        activity.activityType == NSUserActivityTypeBrowsingWeb ? activity.webpageURL : nil
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        if let url = Self.webLink(userActivity) {
            (window?.rootViewController as? FactoryController)?.openLink(url)
        }
    }

    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        if let url = contexts.first?.url {
            (window?.rootViewController as? FactoryController)?.openLink(url)
        }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        (window?.rootViewController as? FactoryController)?.retryUnavailable()
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        (window?.rootViewController as? FactoryController)?.disconnect()
        window = nil
    }
}

private struct Destination: Decodable, Equatable {
    let path: String
    let name: String
    let symbol: String?
    let badge: Int?
    let disabled: Bool?
    let nativeFilters: Bool?

    var icon: String {
        if let symbol { return symbol }
        return switch path {
        case "/": "house"
        case "/queue": "checklist"
        case "/runs": "play.circle"
        case "/sources": "tray"
        case "/controls": "slider.horizontal.3"
        default: "ellipsis.circle"
        }
    }
}

private struct RailState: Decodable, Equatable {
    let signedIn: Bool
    let tabs: [Destination]
    let actions: [Destination]?
    let more: [Destination]
    let tab: String
    let title: String
    let appearance: String
    let hasOptions: Bool
    let waiting: Int
    let issues: Int
    let back: Bool
}

final class FactoryController: UITabBarController, UITabBarControllerDelegate, WKNavigationDelegate, WKScriptMessageHandler, ASWebAuthenticationPresentationContextProviding {
    private let host = Bundle.main.object(forInfoDictionaryKey: "FactoryHost") as! String
    private var signInTask: Task<Void, Never>?
    private var authentication: ASWebAuthenticationSession?
    private var origin: URL {
        #if DEBUG
        if URL(string: "http://" + host)?.host == "localhost" { return URL(string: "http://" + host)! }
        #endif
        return URL(string: "https://" + host)!
    }

    private func isFactory(_ url: URL?) -> Bool {
        guard let url else { return false }
        let defaultPort = origin.scheme == "https" ? 443 : 80
        return url.scheme?.lowercased() == origin.scheme && url.host?.lowercased() == origin.host?.lowercased()
            && (url.port ?? defaultPort) == (origin.port ?? defaultPort)
    }
    private var web: WKWebView!
    private var rail: RailState?
    private weak var filterSheet: UIViewController?
    private var filterPath: String?
    private var unavailableView: UIContentUnavailableView?
    private var retryURL: URL?

    private var launchURL: URL?

    // Only dashboard pages can be opened through a link. Auth, API and static files have other owners.
    private static func isPagePath(_ path: String) -> Bool {
        path.wholeMatch(of: #//(?:runs(?:/[A-Za-z0-9_-]+)?|settings(?:/[A-Za-z0-9_-]+)?|start(?:/new)?|queue|sources|activity|cleanup|controls)?/#) != nil
    }

    func openLink(_ url: URL) {
        guard let link = URLComponents(url: url, resolvingAgainstBaseURL: false),
              link.user == nil, link.password == nil, (link.fragment ?? "").isEmpty,
              var target = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return }
        var path = link.percentEncodedPath
        if link.scheme?.lowercased() == "factory", link.port == nil {
            if let page = link.percentEncodedHost, !page.isEmpty { path = "/" + page + path }
        } else if link.scheme?.lowercased() != "https" || !isFactory(url) { return }
        if path.isEmpty { path = "/" }
        guard Self.isPagePath(path) else { return }
        target.percentEncodedPath = path
        target.percentEncodedQuery = link.percentEncodedQuery
        guard let destination = target.url else { return }
        if web == nil {
            launchURL = destination
        } else {
            signInTask?.cancel()
            authentication?.cancel()
            filterSheet?.dismiss(animated: false)
            retryURL = nil
            loadPage(destination)
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = FactoryScene.canvas
        delegate = self
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "factoryRail")
        let script = try! String(contentsOf: Bundle.main.url(forResource: "FactoryRail", withExtension: "js")!, encoding: .utf8)
        let expected = String(decoding: try! JSONEncoder().encode(origin.absoluteString), as: UTF8.self)
        configuration.userContentController.addUserScript(WKUserScript(
            source: "if (location.origin === \(expected)) {\n\(script)\n}", injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: configuration)
        // Let the native canvas show through until the first document paints.
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.underPageBackgroundColor = .clear
        web.navigationDelegate = self
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.translatesAutoresizingMaskIntoConstraints = false
        showLogin()
        loadPage(launchURL ?? origin)
        launchURL = nil
    }

    func disconnect() {
        signInTask?.cancel()
        authentication?.cancel()
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "factoryRail")
    }

    private func page(_ item: Destination? = nil) -> UINavigationController {
        let content = UIViewController()
        content.view.backgroundColor = FactoryScene.canvas
        let navigation = UINavigationController(rootViewController: content)
        navigation.setNavigationBarHidden(true, animated: false)
        if let item {
            navigation.tabBarItem = UITabBarItem(title: item.name, image: UIImage(systemName: item.icon), tag: 0)
        }
        return navigation
    }

    private func showLogin() {
        rail = nil
        setViewControllers([page()], animated: false)
        setTabBarHidden(true, animated: false)
        attach()
    }

    private func attach() {
        guard let nav = selectedViewController as? UINavigationController, let content = nav.topViewController else { return }
        if web.superview !== content.view {
            web.removeFromSuperview()
            content.view.addSubview(web)
            let area = content.view.safeAreaLayoutGuide
            NSLayoutConstraint.activate([web.leadingAnchor.constraint(equalTo: area.leadingAnchor),
                web.trailingAnchor.constraint(equalTo: area.trailingAnchor), web.topAnchor.constraint(equalTo: area.topAnchor),
                web.bottomAnchor.constraint(equalTo: area.bottomAnchor)])
        }
        guard let rail else { return }
        let hasControls = rail.tabs.contains { $0.path == "/controls" }
        nav.setNavigationBarHidden(hasControls && !rail.back, animated: false)
        content.navigationItem.title = rail.title
        content.navigationItem.leftBarButtonItem = rail.back ? UIBarButtonItem(
            image: UIImage(systemName: "chevron.backward"), primaryAction: UIAction(title: "Back") { [weak self] _ in
                self?.command("back")
            }) : nil
        let pageItems = (rail.actions ?? []).map { action in
            let item = UIBarButtonItem(image: UIImage(systemName: action.icon), primaryAction: UIAction(title: action.name) { [weak self] _ in
                if action.nativeFilters == true {
                    self?.openFilters(action.path)
                } else {
                    self?.command("openAction", path: action.path)
                }
            })
            item.isEnabled = action.disabled != true
            if let count = action.badge, count > 0 { item.badge = .count(count) }
            item.accessibilityLabel = action.name
            return item
        }
        content.setToolbarItems(pageItems, animated: false)
        nav.setToolbarHidden(pageItems.isEmpty, animated: false)
        let actions = rail.more.map { destination in
            UIAction(title: destination.name) { [weak self] _ in self?.command("navigate", path: destination.path) }
        }
        let account = UIAction(title: "More options") { [weak self] _ in self?.command("account") }
        let menu = UIBarButtonItem(image: UIImage(systemName: "ellipsis.circle"), menu: UIMenu(children: actions + (rail.hasOptions ? [account] : [])))
        menu.accessibilityLabel = "More"
        content.navigationItem.rightBarButtonItem = hasControls ? nil : menu
        content.navigationItem.leftBarButtonItem?.accessibilityLabel = "Back"
    }

    private func readFilters(_ path: String, draft: [String: Any]) async throws -> FilterForm {
        guard isFactory(web.url), unavailableView == nil,
              rail?.actions?.contains(where: { $0.path == path && $0.nativeFilters == true }) == true else {
            throw CancellationError()
        }
        let result = try await web.callAsyncJavaScript("return window.factoryRail.editFilters(path, draft)",
            arguments: ["path": path, "draft": draft], in: nil, contentWorld: .page)
        guard let result = result as? [String: Any] else { throw CancellationError() }
        return try JSONDecoder().decode(FilterForm.self, from: JSONSerialization.data(withJSONObject: result))
    }

    private func openFilters(_ path: String) {
        Task { @MainActor [self] in
            guard let form = try? await readFilters(path, draft: [:]), presentedViewController == nil,
                  unavailableView == nil, rail?.actions?.contains(where: { $0.path == path }) == true else { return }
            let sheet = UIHostingController(rootView: FilterSheet(form: form) { [weak self] values, text, apply in
                guard let self else { throw CancellationError() }
                return try await self.readFilters(path, draft: ["values": values, "text": text, "apply": apply])
            })
            sheet.modalPresentationStyle = .pageSheet
            sheet.sheetPresentationController?.detents = [.medium(), .large()]
            sheet.sheetPresentationController?.prefersGrabberVisible = true
            filterPath = path
            filterSheet = sheet
            present(sheet, animated: true)
        }
    }

    private func command(_ name: String, path: String = "") {
        guard isFactory(web.url) else { return }
        web.callAsyncJavaScript("window.factoryRail[action](path)", arguments: ["action": name, "path": path], in: nil, in: .page, completionHandler: nil)
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        guard let rail, rail.tabs.indices.contains(selectedIndex) else { return }
        attach()
        command("navigate", path: rail.tabs[selectedIndex].path)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let source = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, source.protocol == origin.scheme, source.host == origin.host,
              source.port == (origin.port ?? 0) || (origin.port == nil && source.port == 443),
              let data = try? JSONSerialization.data(withJSONObject: message.body),
              let next = try? JSONDecoder().decode(RailState.self, from: data) else { return }
        let defaults = UserDefaults.standard
        if defaults.string(forKey: FactoryScene.appearanceKey) != next.appearance {
            defaults.set(next.appearance, forKey: FactoryScene.appearanceKey)
        }
        view.window?.overrideUserInterfaceStyle = FactoryScene.style(for: next.appearance)
        if let filterSheet, !next.signedIn || next.actions?.contains(where: { $0.path == filterPath && $0.nativeFilters == true }) != true {
            filterSheet.dismiss(animated: true)
        }
        guard next.signedIn, !next.tabs.isEmpty else {
            if rail != nil || (selectedViewController as? UINavigationController)?.isNavigationBarHidden == false { showLogin() }
            return
        }
        guard rail != next else { return }
        if rail?.tabs != next.tabs {
            setViewControllers(next.tabs.map { page($0) }, animated: false)
            setTabBarHidden(false, animated: false)
        }
        for (tab, controller) in zip(next.tabs, viewControllers ?? []) {
            let count = tab.path == "/runs" ? next.waiting : (tab.path == "/controls" ? next.issues : 0)
            controller.tabBarItem.badgeValue = count > 0 ? String(count) : nil
        }
        rail = next
        let index = next.tabs.firstIndex { $0.path == next.tab } ?? 0
        if selectedIndex != index { selectedIndex = index }
        attach()
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if isFactory(url), url.path == "/auth/login", action.targetFrame?.isMainFrame == true {
            decisionHandler(.cancel)
            startSignIn(url)
            return
        }
        if isFactory(url), action.targetFrame != nil { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        // Resolve authenticated thread links in this cookie store before handing the deep link to T3.
        if isFactory(url), url.path.hasPrefix("/api/threads/"), url.path.hasSuffix("/open"),
           action.navigationType == .linkActivated {
            webView.load(action.request)
            return
        }
        if url.scheme == "t3code", url.host == "threads", isFactory(action.sourceFrame.request.url) {
            UIApplication.shared.open(url)
            return
        }
        if action.navigationType == .linkActivated, ["https", "http"].contains(url.scheme) {
            UIApplication.shared.open(url)
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        view.window ?? ASPresentationAnchor()
    }

    private func startSignIn(_ login: URL) {
        guard signInTask == nil, view.window != nil else { return }
        signInTask = Task { @MainActor in
            defer { signInTask = nil }
            do {
                let status = origin.appendingPathComponent("api/auth")
                let (data, response) = try await URLSession.shared.data(from: status)
                let supported = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["nativeHandoff"] as? Bool
                guard isFactory(response.url), supported == true else {
                    throw SignInError.serverUpdate
                }
                try Task.checkCancellation()
                let verifier = Self.base64URL(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) })
                let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
                let start = login.appending(queryItems: [URLQueryItem(name: "native_challenge", value: challenge)])
                let callback = try await systemSignIn(start)
                try Task.checkCancellation()
                guard let fields = URLComponents(url: callback, resolvingAgainstBaseURL: false),
                      fields.scheme == Self.callbackScheme, fields.host == "sign-in", fields.path.isEmpty,
                      fields.queryItems?.first(where: { $0.name == "state" })?.value == challenge,
                      let code = fields.queryItems?.first(where: { $0.name == "code" })?.value,
                      isFactory(web.url) else { throw SignInError.denied }
                // The POST runs in WebKit's cookie store. Only Factory sets the HttpOnly session cookie.
                _ = try await web.callAsyncJavaScript("""
                    const res = await fetch("/api/auth/native/exchange", {
                      method: "POST", credentials: "same-origin", redirect: "error",
                      headers: {"Content-Type": "application/json"}, body: JSON.stringify({code, verifier})
                    });
                    if (!res.ok) throw new Error("Sign-in expired");
                    const destination = new URL((await res.json()).returnTo, location.origin);
                    if (destination.origin !== location.origin) throw new Error("Invalid destination");
                    location.replace(destination.href);
                    """, arguments: ["code": code, "verifier": verifier], in: nil, contentWorld: .defaultClient)
            } catch {
                if Task.isCancelled || (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { return }
                let message = (error as? SignInError)?.errorDescription ?? "Return to Factory and try signing in again."
                let alert = UIAlertController(title: "Couldn’t sign in", message: message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                present(alert, animated: true)
            }
        }
    }

    private static let callbackScheme = "house.thezoo.t3factory"

    private func systemSignIn(_ url: URL) async throws -> URL {
        defer { authentication = nil }
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme(Self.callbackScheme)) { result, error in
                if let result { continuation.resume(returning: result) }
                else { continuation.resume(throwing: error ?? SignInError.denied) }
            }
            authentication = session
            session.presentationContextProvider = self
            if !session.start() { continuation.resume(throwing: SignInError.presentation) }
        }
    }

    private static func base64URL(_ bytes: Data) -> String {
        bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private enum SignInError: LocalizedError {
        case serverUpdate, denied, presentation
        var errorDescription: String? {
            switch self {
            case .serverUpdate: "This Factory server needs an update to support iPhone sign-in."
            case .denied: "Pocket ID sign-in was denied or expired."
            case .presentation: "iOS couldn’t open the sign-in sheet. Try again."
            }
        }
    }

    private func loadPage(_ url: URL) {
        web.load(URLRequest(url: url, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 15))
    }

    func retryUnavailable() {
        guard let url = retryURL, !web.isLoading else { return }
        loadPage(url)
    }

    private func unavailable(_ url: URL?, message: String? = nil) {
        filterSheet?.dismiss(animated: true)
        // Retry only a page GET. Action requests and sign-in callbacks belong to their original attempts.
        if let url, isFactory(url), !url.path.hasPrefix("/api/"), !url.path.hasPrefix("/auth/") {
            retryURL = url
        } else { retryURL = origin }
        var config = UIContentUnavailableConfiguration.empty()
        config.image = UIImage(systemName: "network.slash")
        config.text = "Factory is unreachable"
        config.secondaryText = message ?? "Connect to your home network or Tailscale, then retry."
        config.button.title = "Retry connection"
        config.button.image = UIImage(systemName: "arrow.clockwise")
        config.buttonProperties.primaryAction = UIAction(title: "Retry connection") { [weak self] _ in self?.retryUnavailable() }
        if let unavailableView { unavailableView.configuration = config; return }
        let screen = UIContentUnavailableView(configuration: config)
        screen.backgroundColor = .systemBackground
        screen.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(screen)
        NSLayoutConstraint.activate([screen.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            screen.trailingAnchor.constraint(equalTo: view.trailingAnchor), screen.topAnchor.constraint(equalTo: view.topAnchor),
            screen.bottomAnchor.constraint(equalTo: view.bottomAnchor)])
        unavailableView = screen
        UIAccessibility.post(notification: .screenChanged, argument: screen)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, isFactory(response.response.url),
           let http = response.response as? HTTPURLResponse,
           (500...599).contains(http.statusCode) || (http.statusCode == 404 && Self.isPagePath(http.url?.path ?? "")) {
            // Off the private network, the public association-file host returns 404 for dashboard pages.
            unavailable(http.url)
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isFactory(webView.url) else { return }
        unavailableView?.removeFromSuperview()
        unavailableView = nil
        retryURL = nil
    }

    private func navigationFailed(_ error: Error) {
        let failure = error as NSError
        if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
        // WebKit also reports a policy cancellation when opening the system sign-in sheet or an external link.
        if failure.domain == "WebKitErrorDomain" && failure.code == 102 { return }
        unavailable(failure.userInfo[NSURLErrorFailingURLErrorKey] as? URL,
                    message: failure.domain == NSURLErrorDomain ? nil : failure.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}
