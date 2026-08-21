import AVFoundation
import DonkeyKitModels
import Foundation
import UIKit

/// The phone's HTTP client for the hosted Cut API (/api/cut-cloud/*). The
/// bearer session comes from the keychain, and every request carries the iOS
/// client header — the marker that links this account for the desktop's phone
/// features.
final class CutCloudClient: NSObject {
    private let base = AuthBackend.baseURL

    // MARK: Requests

    private var token: String? {
        KeychainStore.read(AuthController.tokenKey).flatMap { String(data: $0, encoding: .utf8) }
    }

    private func request(
        _ method: String,
        _ path: String,
        body: [String: Any]? = nil
    ) throws -> URLRequest {
        guard let token else { throw CloudSyncError.unauthorized }
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("ios", forHTTPHeaderField: "x-donkey-cut-client")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw CloudSyncError.transport
        }
        guard let http = response as? HTTPURLResponse else { throw CloudSyncError.transport }
        switch http.statusCode {
        case 200..<300: return data
        case 401, 403: throw CloudSyncError.unauthorized
        case 413: throw CloudSyncError.storageFull
        default: throw CloudSyncError.transport
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        guard let value = try? JSONDecoder().decode(type, from: data) else {
            throw CloudSyncError.transport
        }
        return value
    }

    /// Follows the API's 302 by hand and hands back the CDN URL it points at,
    /// so AVPlayer streams the CDN directly.
    private func resolveRedirect(_ path: String) async throws -> URL {
        let request = try request("GET", path)
        let response: URLResponse
        do {
            (_, response) = try await URLSession.shared.data(for: request, delegate: RedirectCatcher())
        } catch {
            throw CloudSyncError.transport
        }
        guard let http = response as? HTTPURLResponse,
              (300..<400).contains(http.statusCode),
              let location = http.value(forHTTPHeaderField: "Location"),
              let url = URL(string: location, relativeTo: base) else {
            throw CloudSyncError.transport
        }
        return url.absoluteURL
    }
}

// MARK: - Media up-sync

extension CutCloudClient: CloudSyncServicing {
    private struct PresignResponse: Decodable {
        var fileName: String
        var key: String
        var url: String?
        var done: Bool?
    }

    private struct AssetResponse: Decodable {
        var id: String
        var fileName: String
    }

    func uploadLibraryMedia(
        _ upload: LibraryUpload,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> RemoteAsset {
        let presign = try await presignLibrary(
            fileName: upload.fileName,
            mime: upload.mime,
            bytes: upload.bytes,
            resume: upload.resume
        )
        if presign.done != true {
            guard let url = presign.url.flatMap(URL.init(string:)) else { throw CloudSyncError.transport }
            try await putFile(upload.fileURL, to: url, mime: upload.mime, progress: progress)
        }
        let posterKey: String? = if let poster = upload.poster {
            try? await uploadPoster(poster, besides: presign.fileName)
        } else {
            nil
        }
        var meta: [String: Any] = [
            "name": upload.name,
            "type": upload.type,
            "duration": upload.duration,
            "origin": upload.origin,
        ]
        if let width = upload.width, let height = upload.height {
            meta["width"] = width
            meta["height"] = height
        }
        var body: [String: Any] = ["key": presign.key, "meta": meta]
        if let posterKey { body["posterKey"] = posterKey }
        let data = try await send(
            try request("POST", "/api/cut-cloud/library/complete", body: body)
        )
        let asset = try decode(AssetResponse.self, from: data)
        progress(1)
        return RemoteAsset(id: asset.id, fileName: asset.fileName)
    }

    private func presignLibrary(
        fileName: String,
        mime: String,
        bytes: Int64,
        resume: Bool
    ) async throws -> PresignResponse {
        let data = try await send(
            try request(
                "POST",
                "/api/cut-cloud/library/presign",
                body: ["fileName": fileName, "mime": mime, "bytes": bytes, "resume": resume]
            )
        )
        return try decode(PresignResponse.self, from: data)
    }

    /// The recording's thumbnail goes up beside the movie so the desktop card
    /// paints without decoding video. Best-effort: the upload stands without it.
    private func uploadPoster(_ poster: Data, besides fileName: String) async throws -> String {
        let posterName = (fileName as NSString).deletingPathExtension + "-poster.jpg"
        let presign = try await presignLibrary(
            fileName: posterName,
            mime: "image/jpeg",
            bytes: Int64(poster.count),
            resume: true
        )
        if presign.done != true {
            guard let url = presign.url.flatMap(URL.init(string:)) else { throw CloudSyncError.transport }
            try await putData(poster, to: url, mime: "image/jpeg")
        }
        return presign.key
    }

    private func putFile(
        _ file: URL,
        to url: URL,
        mime: String,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws {
        let response: URLResponse
        do {
            (_, response) = try await URLSession.shared.upload(
                for: putRequest(url, mime: mime),
                fromFile: file,
                delegate: UploadProgressDelegate(progress)
            )
        } catch {
            throw CloudSyncError.transport
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CloudSyncError.transport
        }
    }

    private func putData(_ data: Data, to url: URL, mime: String) async throws {
        let response: URLResponse
        do {
            (_, response) = try await URLSession.shared.upload(
                for: putRequest(url, mime: mime),
                from: data
            )
        } catch {
            throw CloudSyncError.transport
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CloudSyncError.transport
        }
    }

    private func putRequest(_ url: URL, mime: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        // The presigned URL is signed over this content type.
        request.setValue(mime, forHTTPHeaderField: "Content-Type")
        return request
    }

    func deleteLibraryAsset(id: String) async throws {
        _ = try await send(try request("DELETE", "/api/cut-cloud/library/\(id)"))
    }

    func importInspirationLink(_ url: URL) async throws -> String {
        struct QueuedJob: Decodable { var jobId: String }
        let data = try await send(
            try request(
                "POST",
                "/api/cut-cloud/library/import-url",
                body: ["url": url.absoluteString, "origin": "inspiration"]
            )
        )
        return try decode(QueuedJob.self, from: data).jobId
    }

    func importedLink(jobId: String) async throws -> JobOutcome<ImportedLink> {
        struct JobStatus: Decodable {
            struct Result: Decodable {
                struct Asset: Decodable {
                    var id: String
                    var fileName: String
                    var type: String
                }
                var assets: [Asset]?
            }
            var state: String
            var result: Result?
        }
        let data = try await send(try request("GET", "/api/cut-cloud/jobs/\(jobId)"))
        let status = try decode(JobStatus.self, from: data)
        switch status.state {
        case "queued", "running":
            return .running
        case "done":
            // A source that was only words brings back no media; the card
            // stays the link it was saved as.
            guard let asset = status.result?.assets?.first else { return .failed }
            return .done(
                ImportedLink(
                    assetId: asset.id,
                    fileName: asset.fileName,
                    isVideo: asset.type == "video"
                )
            )
        default:
            return .failed
        }
    }

    func downloadLibraryMedia(fileName: String, to destination: URL) async throws {
        let path = "/api/cut-cloud/library/media/" + (fileName.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? fileName)
        let url = try await resolveRedirect(path)
        let temporary: URL
        do {
            (temporary, _) = try await URLSession.shared.download(from: url)
        } catch {
            throw CloudSyncError.transport
        }
        try? FileManager.default.removeItem(at: destination)
        do {
            try FileManager.default.moveItem(at: temporary, to: destination)
        } catch {
            throw CloudSyncError.transport
        }
    }

    func fetchUsage() async throws -> StorageUsage {
        struct UsageResponse: Decodable {
            var bytes: Int64
            var quotaBytes: Int64?
        }
        let data = try await send(try request("GET", "/api/cut-cloud/usage"))
        let usage = try decode(UsageResponse.self, from: data)
        return StorageUsage(bytes: usage.bytes, quotaBytes: usage.quotaBytes)
    }

    // MARK: Notes

    private struct NoteDTO: Decodable {
        var id: String
        var title: String
        var body: String
        var colorIndex: Int
        var folderId: String?
        var updatedAt: Double
        var deletedAt: Double?
        var createdAt: Double
    }

    private struct NoteFolderDTO: Decodable {
        var id: String
        var name: String
        var updatedAt: Double
        var createdAt: Double
    }

    private func remoteNote(_ dto: NoteDTO, id: UUID) -> RemoteNote {
        RemoteNote(
            id: id,
            title: dto.title,
            body: dto.body,
            colorIndex: dto.colorIndex,
            folderId: dto.folderId.flatMap(UUID.init(uuidString:)),
            updatedAt: Date(timeIntervalSince1970: dto.updatedAt / 1000),
            deletedAt: dto.deletedAt.map { Date(timeIntervalSince1970: $0 / 1000) },
            createdAt: Date(timeIntervalSince1970: dto.createdAt / 1000)
        )
    }

    func fetchNotes() async throws -> RemoteNotes {
        struct NotesResponse: Decodable {
            var notes: [NoteDTO]
            var folders: [NoteFolderDTO]?
        }
        let data = try await send(try request("GET", "/api/cut-cloud/notes"))
        let response = try decode(NotesResponse.self, from: data)
        return RemoteNotes(
            notes: response.notes.compactMap { dto in
                guard let id = UUID(uuidString: dto.id) else { return nil }
                return remoteNote(dto, id: id)
            },
            // Folders are keyed by the id whichever client made them chose,
            // and both clients mint UUIDs; anything else is not this phone's.
            // A missing key stays nil so the merge can tell it from "none".
            folders: response.folders?.compactMap { dto in
                guard let id = UUID(uuidString: dto.id) else { return nil }
                return RemoteNoteFolder(
                    id: id,
                    name: dto.name,
                    updatedAt: Date(timeIntervalSince1970: dto.updatedAt / 1000),
                    createdAt: Date(timeIntervalSince1970: dto.createdAt / 1000)
                )
            }
        )
    }

    func putNote(_ note: RemoteNote) async throws -> RemoteNote {
        var body: [String: Any] = [
            "title": note.title,
            "body": note.body,
            "colorIndex": note.colorIndex,
            "updatedAt": Int(note.updatedAt.timeIntervalSince1970 * 1000),
        ]
        body["folderId"] = note.folderId.map { $0.uuidString.lowercased() } ?? NSNull()
        let data = try await send(
            try request("PUT", "/api/cut-cloud/notes/\(note.id.uuidString.lowercased())", body: body)
        )
        return remoteNote(try decode(NoteDTO.self, from: data), id: note.id)
    }

    func deleteNote(id: UUID) async throws {
        _ = try await send(try request("DELETE", "/api/cut-cloud/notes/\(id.uuidString.lowercased())"))
    }

    func putNoteFolder(_ folder: RemoteNoteFolder) async throws {
        _ = try await send(
            try request(
                "PUT",
                "/api/cut-cloud/notes/folders/\(folder.id.uuidString.lowercased())",
                body: ["name": folder.name]
            )
        )
    }

    func deleteNoteFolder(id: UUID) async throws {
        _ = try await send(
            try request("DELETE", "/api/cut-cloud/notes/folders/\(id.uuidString.lowercased())")
        )
    }
}

// MARK: - Projects down-sync

extension CutCloudClient: CloudProjectsServicing {
    private struct ProjectDTO: Decodable {
        var id: String
        var name: String
        var duration: Double
        var updatedAt: Double
        var hasPreview: Bool?
        var previewFile: String?
        var previewIsImage: Bool?
        var previewStart: Double?
    }

    func fetchProjects() async throws -> [RemoteProject] {
        let data = try await send(try request("GET", "/api/cut-cloud/projects"))
        return try decode([ProjectDTO].self, from: data).map { dto in
            RemoteProject(
                id: dto.id,
                name: dto.name,
                duration: dto.duration,
                updatedAt: Date(timeIntervalSince1970: dto.updatedAt / 1000),
                hasPreview: dto.hasPreview ?? false,
                previewFile: dto.previewFile,
                previewIsImage: dto.previewIsImage ?? false,
                previewStart: dto.previewStart ?? 0
            )
        }
    }

    func fetchExports(projectId: String) async throws -> [RemoteExport] {
        struct ExportDTO: Decodable {
            var file: String
            var mtime: Double
        }
        let data = try await send(try request("GET", "/api/cut-cloud/projects/\(projectId)/exports"))
        return try decode([ExportDTO].self, from: data).map {
            RemoteExport(file: $0.file, modifiedAt: Date(timeIntervalSince1970: $0.mtime / 1000))
        }
    }

    func streamURL(project: RemoteProject, export: RemoteExport?) async throws -> URL {
        if let export {
            return try await resolveRedirect("/api/cut-cloud/projects/\(project.id)/exports/\(export.file)")
        }
        guard project.hasPreview else { throw CloudSyncError.transport }
        return try await resolveRedirect("/api/cut-cloud/projects/\(project.id)/preview")
    }

    func thumbnailFile(for project: RemoteProject) async -> URL? {
        let directory = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appending(path: "ProjectThumbs")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let stamp = Int(project.updatedAt.timeIntervalSince1970 * 1000)
        let file = directory.appending(path: "\(project.id)-\(stamp).jpg")
        if FileManager.default.fileExists(atPath: file.localPath) { return file }
        guard let image = await thumbnailImage(for: project),
              let data = image.jpegData(compressionQuality: 0.8) else { return nil }
        try? data.write(to: file, options: .atomic)
        // Versions of this project from before the edit leave once the new
        // poster is on disk, so a card never points at a file that is gone.
        let stale = (try? FileManager.default.contentsOfDirectory(atPath: directory.localPath))?
            .filter { $0.hasPrefix("\(project.id)-") && $0 != file.lastPathComponent } ?? []
        for name in stale {
            try? FileManager.default.removeItem(at: directory.appending(path: name))
        }
        return file
    }

    /// Only a poster rides the network: a still poster file as its own bytes,
    /// or one decoded frame of the composited preview / poster video.
    private func thumbnailImage(for project: RemoteProject) async -> UIImage? {
        if project.previewIsImage, let file = project.previewFile {
            guard let url = try? await resolveRedirect("/api/cut-cloud/projects/\(project.id)/media/\(file)"),
                  let (data, _) = try? await URLSession.shared.data(from: url) else { return nil }
            return UIImage(data: data)
        }
        let source: (path: String, at: TimeInterval)? = if project.hasPreview {
            ("/api/cut-cloud/projects/\(project.id)/preview", 0)
        } else if let file = project.previewFile {
            ("/api/cut-cloud/projects/\(project.id)/media/\(file)", project.previewStart)
        } else {
            nil
        }
        guard let source, let url = try? await resolveRedirect(source.path) else { return nil }
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 720, height: 720)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
        let time = CMTime(seconds: source.at, preferredTimescale: 600)
        guard let frame = try? await generator.image(at: time).image else { return nil }
        return UIImage(cgImage: frame)
    }
}

// MARK: - Analytics

extension CutCloudClient: AnalyticsServicing {
    /// The nightly analytics rollup. The API serves it to super users only,
    /// so a regular account reads as unauthorized here.
    func fetchAnalyticsRollup() async throws -> AnalyticsRollup {
        let request = try request("GET", "/api/analytics/rollup")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw CloudSyncError.transport
        }
        guard let http = response as? HTTPURLResponse else { throw CloudSyncError.transport }
        switch http.statusCode {
        case 200..<300: break
        case 404: throw AnalyticsError.noRollup
        case 401, 403: throw CloudSyncError.unauthorized
        default: throw CloudSyncError.transport
        }
        return try decode(AnalyticsRollup.self, from: data)
    }
}

// MARK: - Recording payloads

extension CutCloudClient {
    /// Everything an upload needs, read off the finished recording: bytes on
    /// disk, probed dimensions, and the stored thumbnail as the poster.
    static func uploadPayload(for recording: Recording, media: MediaModel) async -> LibraryUpload? {
        let fileURL = media.movieURL(for: recording)
        guard let size = fileURL.fileByteCount else { return nil }
        var width: Int?
        var height: Int?
        let asset = AVURLAsset(url: fileURL)
        if let track = try? await asset.loadTracks(withMediaType: .video).first,
           let (naturalSize, transform) = try? await track.load(.naturalSize, .preferredTransform) {
            let rect = CGRect(origin: .zero, size: naturalSize).applying(transform)
            width = Int(abs(rect.width).rounded())
            height = Int(abs(rect.height).rounded())
        }
        let poster = media.thumbnailURL(for: recording).flatMap { try? Data(contentsOf: $0) }
        return LibraryUpload(
            fileURL: fileURL,
            fileName: recording.fileName,
            mime: "video/quicktime",
            bytes: size,
            name: "Recording \(recording.createdAt.formatted(date: .abbreviated, time: .shortened))",
            type: "video",
            duration: recording.duration,
            width: width,
            height: height,
            origin: "camera",
            poster: poster
        )
    }
}

// MARK: - Session delegates

/// Reports PUT progress off the session's queue back to the caller.
private nonisolated final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate {
    private let onProgress: @Sendable (Double) -> Void

    init(_ onProgress: @escaping @Sendable (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}

/// Stops the API's 302 so the Location header can be read.
private nonisolated final class RedirectCatcher: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
