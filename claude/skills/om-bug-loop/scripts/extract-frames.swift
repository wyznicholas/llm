import Foundation
import AVFoundation
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: extract <movie> <outdir> [step]"); exit(1) }
let url = URL(fileURLWithPath: args[1])
let outdir = args[2]
let step = args.count > 3 ? Double(args[3])! : 0.5

let asset = AVURLAsset(url: url)
let sem = DispatchSemaphore(value: 0)
var durSec: Double = 0
var natSize = CGSize.zero
Task {
    if let d = try? await asset.load(.duration) { durSec = CMTimeGetSeconds(d) }
    if let tracks = try? await asset.loadTracks(withMediaType: .video), let t = tracks.first {
        if let s = try? await t.load(.naturalSize) { natSize = s }
    }
    sem.signal()
}
sem.wait()
FileHandle.standardError.write("DURATION=\(durSec) SIZE=\(Int(natSize.width))x\(Int(natSize.height))\n".data(using:.utf8)!)

let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 60)
gen.requestedTimeToleranceAfter  = CMTime(value: 1, timescale: 60)

var t = 0.0
while t < durSec {
    let time = CMTime(seconds: t, preferredTimescale: 600)
    do {
        let cg = try gen.copyCGImage(at: time, actualTime: nil)
        let rep = NSBitmapImageRep(cgImage: cg)
        if let data = rep.representation(using: .png, properties: [:]) {
            let name = String(format: "%@/f_%07.2f.png", outdir, t)
            try data.write(to: URL(fileURLWithPath: name))
            print(String(format: "%.2f ok %dx%d", t, cg.width, cg.height))
        }
    } catch { print(String(format: "%.2f ERR %@", t, "\(error)")) }
    t += step
}
