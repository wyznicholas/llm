import CoreGraphics
import Foundation
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
let target = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Discord"
for w in list {
    guard let owner = w[kCGWindowOwnerName as String] as? String, owner == target else { continue }
    guard let b = w[kCGWindowBounds as String] as? [String: Any],
          let num = w[kCGWindowNumber as String] as? Int else { continue }
    let wd = (b["Width"] as? Double) ?? 0, ht = (b["Height"] as? Double) ?? 0
    if wd < 200 || ht < 200 { continue }   // skip tooltips/panels
    print("\(num)\t\(Int(wd))x\(Int(ht))")
}
