// blankcheck.swift — is this screenshot actually painted, or a blank window?
//
// `screencapture -l <wid>` on a window that exists but has not drawn yields a
// perfectly valid PNG: right dimensions, non-zero size, uniform colour. A
// file-size guard cannot tell it from a real capture, which is how Discord
// references silently degraded for six consecutive nights (2026-09-06..11)
// while the script reported success.
//
// So look at the pixels. Downsample to 32x32 and ask two questions a painted
// UI always answers and a blank surface never does: how many distinct colours,
// and how much luminance varies.
//
// exit 0 = painted · exit 8 = blank · exit 9 = unreadable
import CoreGraphics
import Foundation
import ImageIO

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("usage: blankcheck.swift <image.png>\n".data(using: .utf8)!)
    exit(9)
}
let url = URL(fileURLWithPath: args[1])

guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write("blankcheck: cannot decode \(args[1])\n".data(using: .utf8)!)
    exit(9)
}

let n = 32
var buf = [UInt8](repeating: 0, count: n * n * 4)
guard let ctx = CGContext(data: &buf, width: n, height: n, bitsPerComponent: 8,
                          bytesPerRow: n * 4, space: CGColorSpaceCreateDeviceRGB(),
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    FileHandle.standardError.write("blankcheck: cannot build sampling context\n".data(using: .utf8)!)
    exit(9)
}
ctx.interpolationQuality = .low
ctx.draw(img, in: CGRect(x: 0, y: 0, width: n, height: n))

var colours = Set<UInt32>()
var lums = [Double]()
lums.reserveCapacity(n * n)
for i in stride(from: 0, to: buf.count, by: 4) {
    let r = UInt32(buf[i]), g = UInt32(buf[i + 1]), b = UInt32(buf[i + 2])
    colours.insert(r << 16 | g << 8 | b)
    lums.append(0.2126 * Double(r) + 0.7152 * Double(g) + 0.0722 * Double(b))
}
let mean = lums.reduce(0, +) / Double(lums.count)
let sd = (lums.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(lums.count)).squareRoot()

// A painted UI window carries hundreds of distinct colours across 1024 samples
// and real luminance spread. Both thresholds are deliberately generous: the
// cost of a false "blank" is one written reference, the cost of a false
// "painted" is six nights of silent nonsense.
let painted = colours.count > 8 && sd > 2.0
print(String(format: "distinct=%d stddev=%.2f %@", colours.count, sd, painted ? "painted" : "BLANK"))
exit(painted ? 0 : 8)
