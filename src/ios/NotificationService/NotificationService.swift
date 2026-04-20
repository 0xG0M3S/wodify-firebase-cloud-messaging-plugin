import UserNotifications

class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

        guard let bestAttemptContent else {
            contentHandler(request.content)
            return
        }

        // fcm_options.image is the standard FCM v1 API field for notification images
        let imageURLString = (request.content.userInfo["fcm_options"] as? [String: Any])?["image"] as? String
            ?? request.content.userInfo["imageUrl"] as? String

        guard let urlString = imageURLString, let url = URL(string: urlString) else {
            contentHandler(bestAttemptContent)
            return
        }

        downloadAttachment(from: url) { attachment in
            if let attachment {
                bestAttemptContent.attachments = [attachment]
            }
            contentHandler(bestAttemptContent)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }

    private func downloadAttachment(from url: URL, completion: @escaping (UNNotificationAttachment?) -> Void) {
        URLSession.shared.downloadTask(with: url) { tempURL, _, _ in
            guard let tempURL else {
                completion(nil)
                return
            }
            // UNNotificationAttachment requires the file to persist after the task completes
            let fileName = url.lastPathComponent.isEmpty ? "attachment" : url.lastPathComponent
            let destURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(fileName)
            try? FileManager.default.removeItem(at: destURL)
            try? FileManager.default.moveItem(at: tempURL, to: destURL)
            completion(try? UNNotificationAttachment(identifier: fileName, url: destURL))
        }.resume()
    }
}
