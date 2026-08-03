#!/usr/bin/env swift

import AppKit
import Foundation
import WebKit

@available(macOS 15.4, *)
@MainActor
func verifyExtension(at suppliedURL: URL) async throws {
    let webExtension: WKWebExtension
    if suppliedURL.pathExtension == "appex" {
        guard let bundle = Bundle(url: suppliedURL) else {
            throw NSError(
                domain: "InterceptorSafariVerifier",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "could not open app-extension bundle"]
            )
        }
        webExtension = try await WKWebExtension(appExtensionBundle: bundle)
    } else {
        webExtension = try await WKWebExtension(resourceBaseURL: suppliedURL)
    }
    guard webExtension.hasBackgroundContent else {
        throw NSError(
            domain: "InterceptorSafariVerifier",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "manifest has no background content"]
        )
    }

    let configuration = WKWebExtensionController.Configuration.nonPersistent()
    let controller = WKWebExtensionController(configuration: configuration)
    let context = WKWebExtensionContext(for: webExtension)
    context.uniqueIdentifier = "com.interceptor.safari.bootstrap-verifier"

    try controller.load(context)
    defer { try? controller.unload(context) }

    let loadError: Error? = await withCheckedContinuation { continuation in
        var finished = false
        func finish(_ error: Error?) {
            guard !finished else { return }
            finished = true
            continuation.resume(returning: error)
        }

        context.loadBackgroundContent { error in
            finish(error)
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(5))
            // On current WebKit, a successfully running MV3 worker can keep the
            // completion open. Runtime load failures are published on the
            // context promptly, so bound this verifier instead of hanging CI.
            finish(nil)
        }
    }
    if let loadError { throw loadError }

    // `context.errors` currently imports as `[any Error]` but WebKit returns an
    // internal WKNSError object that Swift cannot cast to `Swift.Error`. Read
    // the Objective-C collection to avoid crashing the verifier itself.
    let rawErrors = (context as NSObject).value(forKey: "errors") as? NSArray
    if let first = rawErrors?.firstObject as? NSObject {
        let domain = first.value(forKey: "domain") as? String ?? "WKWebExtensionContextErrorDomain"
        let code = first.value(forKey: "code") as? Int ?? 0
        let description = first.value(forKey: "localizedDescription") as? String ?? "unknown runtime error"
        throw NSError(domain: domain, code: code, userInfo: [NSLocalizedDescriptionKey: description])
    }
}

guard CommandLine.arguments.count == 2 else {
    fputs("usage: verify-safari-extension.swift <extension-resource-directory-or-appex>\n", stderr)
    exit(64)
}

guard #available(macOS 15.4, *) else {
    fputs("Safari extension verification requires macOS 15.4 or newer\n", stderr)
    exit(69)
}

let suppliedPath = CommandLine.arguments[1]
let absolutePath = suppliedPath.hasPrefix("/")
    ? suppliedPath
    : URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        .appendingPathComponent(suppliedPath, isDirectory: true).path
let extensionURL = URL(fileURLWithPath: absolutePath, isDirectory: true).standardizedFileURL
NSApplication.shared.setActivationPolicy(.prohibited)

do {
    try await verifyExtension(at: extensionURL)
    print("Safari background bootstrap: OK")
} catch {
    let nsError = error as NSError
    fputs("Safari background bootstrap: FAILED (\(nsError.domain) \(nsError.code)): \(nsError.localizedDescription)\n", stderr)
    exit(1)
}
