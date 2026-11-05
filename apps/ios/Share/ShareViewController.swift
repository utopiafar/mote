import SwiftUI
import UIKit
import MoteCentral

final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        preferredContentSize = CGSize(width: UIScreen.main.bounds.width, height: 335)
        model.onFinish = { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        }
        let flow = ShareFlowView(model: model, onCancel: { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        }, onHeight: { [weak self] height in
            guard let self, abs(self.preferredContentSize.height - height) > 0.5 else { return }
            DispatchQueue.main.async {
                self.preferredContentSize = CGSize(width: UIScreen.main.bounds.width, height: height)
            }
        })
        let host = UIHostingController(rootView: flow)
        host.view.backgroundColor = .clear
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)

        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        let contentText = items.compactMap { $0.attributedContentText?.string }.first { !$0.isEmpty }
        Task { await model.load(providers: providers, contentText: contentText) }
    }
}
