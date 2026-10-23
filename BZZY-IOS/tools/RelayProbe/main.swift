import Foundation
import RelayKit

func emit(_ value: CoreJSONValue) {
    if let data = try? JSONEncoder().encode(value) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

do {
    if CommandLine.arguments.dropFirst() == ["--core-observer"] {
        // One private stdin record; invitation codes never appear in argv/logs.
        guard let line = readLine(), line.utf8.count <= 8192,
              let data = line.data(using: .utf8),
              let input = try JSONSerialization.jsonObject(with: data) as? [String: String],
              Set(input.keys) == ["code", "hostFingerprint", "sessionId"],
              let code = input["code"], let host = input["hostFingerprint"], let session = input["sessionId"] else {
            throw CoreApplicationError("INVALID_REQUEST")
        }
        let result = try await RelayDiagnostics.observeCore(code: code, expectedHost: host, expectedSession: session, progress: emit)
        emit(result)
    } else {
        let result = try await RelayDiagnostics.checkPublicEndpoint()
        print("PASS: \(result)")
    }
} catch {
    emit(.object(["stage": .string("failed"), "code": .string((error as? CoreApplicationError)?.code ?? RelayDiagnostics.failureCode(error))]))
    exit(1)
}
