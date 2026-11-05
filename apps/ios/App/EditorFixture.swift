import UIKit
import MoteStorage

@MainActor
enum EditorFixture {
    static func makeDraft(name: String, store: EditorDraftStore) throws -> EditorDraft {
        guard name != "empty" else { return EditorDraft() }
        let photo = try store.importData(photoData(), kind: .photo, fileName: "照片.png")
        var attachments = [photo]
        if name != "audio-false" {
            let audio = try store.importData(audioData(), kind: .audio, fileName: "录音.wav", duration: 134)
            attachments.append(audio)
        }
        return EditorDraft(
            text: "周四和房东确认：暖气费按实际用量分摊，月底前把账单照片发给他。\n押金下个月退，记得要收据。",
            attachments: attachments
        )
    }

    private static func photoData() -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 296, height: 224))
        return renderer.image { context in
            UIColor(red: 0.914, green: 0.898, blue: 0.863, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 296, height: 224))
            UIColor(red: 0.973, green: 0.969, blue: 0.953, alpha: 1).setFill()
            context.fill(CGRect(x: 20, y: 20, width: 256, height: 184))
            UIColor(red: 0.227, green: 0.212, blue: 0.196, alpha: 1).setStroke()
            let lines = [
                CGRect(x: 44, y: 59, width: 96, height: 5),
                CGRect(x: 44, y: 83, width: 140, height: 5),
                CGRect(x: 44, y: 107, width: 72, height: 5),
                CGRect(x: 44, y: 147, width: 88, height: 5),
            ]
            for line in lines {
                let path = UIBezierPath(roundedRect: line, cornerRadius: 2.5)
                UIColor(red: 0.227, green: 0.212, blue: 0.196, alpha: 1).setFill()
                path.fill()
            }
            let check = UIBezierPath()
            check.move(to: CGPoint(x: 196, y: 132))
            check.addLine(to: CGPoint(x: 212, y: 148))
            check.addLine(to: CGPoint(x: 244, y: 112))
            check.lineWidth = 5
            check.lineCapStyle = .round
            check.lineJoinStyle = .round
            UIColor(red: 0.710, green: 0.263, blue: 0.184, alpha: 1).setStroke()
            check.stroke()
        }.pngData() ?? Data()
    }

    private static func audioData() -> Data {
        let sampleRate: UInt32 = 8_000
        let sampleCount = 16_000
        let dataSize = UInt32(sampleCount * 2)
        var data = Data()
        data.append(Data("RIFF".utf8))
        appendLittleEndian(UInt32(36) + dataSize, to: &data)
        data.append(Data("WAVEfmt ".utf8))
        appendLittleEndian(UInt32(16), to: &data)
        appendLittleEndian(UInt16(1), to: &data)
        appendLittleEndian(UInt16(1), to: &data)
        appendLittleEndian(sampleRate, to: &data)
        appendLittleEndian(sampleRate * 2, to: &data)
        appendLittleEndian(UInt16(2), to: &data)
        appendLittleEndian(UInt16(16), to: &data)
        data.append(Data("data".utf8))
        appendLittleEndian(dataSize, to: &data)
        data.append(Data(count: Int(dataSize)))
        return data
    }

    private static func appendLittleEndian<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { bytes in
            data.append(contentsOf: bytes)
        }
    }
}
