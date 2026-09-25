#!/usr/bin/env bun
// stamp.ts — provenance on artifacts, written by a tool instead of by hand.
//
// Nineteen of ~24 adversarial-audit FAILs were one shape: a figure with no
// artifact behind it, an artifact with no arm, a capture not tied to a commit.
// That is not a discipline problem. Provenance written by hand is provenance
// forgotten under time pressure, and every rule telling agents to remember it
// has been obeyed unevenly.
//
// So the tool writes it, and — more importantly — the tool can say what is
// MISSING it. `manifest` is the half that kills the failure class: it lists
// every artifact, its provenance, and loudly names the ones that have none.
// Run it before reporting and an audit has nothing left to find.
//
//   stamp.ts write   <file> --arm before|after --commit <sha> [--asset v=…] [--note "…"]
//   stamp.ts figure  <name> --file <path> --value "<what it shows>"
//   stamp.ts manifest <evidence-dir> [--strict]
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

/** Text formats we can prepend a comment header to. Everything else gets a
 *  sidecar, because a PNG with a text header is a corrupt PNG. */
const COMMENTABLE: Record<string, (l: string) => string> = {
  ".txt": l => `# ${l}`, ".log": l => `# ${l}`, ".md": l => `<!-- ${l} -->`,
  ".ts": l => `// ${l}`, ".mjs": l => `// ${l}`, ".py": l => `# ${l}`,
};
const HEADER_MARK = "om-bug-loop:provenance";
const FIGURES = "FIGURES.tsv";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Prov { arm?: string; commit?: string; asset?: string; note?: string; at: string }

function provOf(file: string): Prov | null {
  const side = `${file}.prov.json`;
  if (existsSync(side)) { try { return JSON.parse(readFileSync(side, "utf8")); } catch { return null; } }
  const ext = extname(file);
  if (!(ext in COMMENTABLE) || !existsSync(file)) return null;
  const head = readFileSync(file, "utf8").slice(0, 800);
  if (!head.includes(HEADER_MARK)) return null;
  const grab = (k: string) => new RegExp(`${k}=([^\\s|]+)`).exec(head)?.[1];
  return { arm: grab("arm"), commit: grab("commit"), asset: grab("asset"), at: grab("at") ?? "" };
}

function write(): number {
  const file = process.argv[3];
  if (!file || !existsSync(file)) {
    process.stderr.write(`stamp write: no such file: ${file}\n`); return 1;
  }
  const prov: Prov = {
    arm: argValue("--arm"), commit: argValue("--commit"),
    asset: argValue("--asset"), note: argValue("--note"),
    at: new Date().toISOString(),
  };
  if (!prov.arm || !prov.commit) {
    process.stderr.write("stamp write: --arm and --commit are both required — an\n" +
      "artifact that cannot name its arm and its commit is not evidence.\n");
    return 64;
  }
  const ext = extname(file);
  const line = `${HEADER_MARK} arm=${prov.arm} commit=${prov.commit}` +
    (prov.asset ? ` asset=${prov.asset}` : "") + ` at=${prov.at}` +
    (prov.note ? ` | ${prov.note}` : "");
  if (ext in COMMENTABLE) {
    const body = readFileSync(file, "utf8");
    const renderedMark = COMMENTABLE[ext]!(HEADER_MARK);
    const ownHeaderStart = renderedMark.slice(0, renderedMark.indexOf(HEADER_MARK)) + HEADER_MARK;
    const dropOwnHeaders = (text: string): string => {
      while (true) {
        const newline = text.indexOf("\n");
        const firstLine = newline < 0 ? text : text.slice(0, newline);
        const suffix = firstLine.startsWith(ownHeaderStart)
          ? firstLine.slice(ownHeaderStart.length) : null;
        if (suffix === null || (suffix !== "" && !suffix.startsWith(" "))) return text;
        text = newline < 0 ? "" : text.slice(newline + 1);
      }
    };

    // A shebang must stay on line 1; the old broad guard deleted foreign first lines (T236).
    let stripped = dropOwnHeaders(body);
    let shebang = "";
    if (stripped.startsWith("#!")) {
      const newline = stripped.indexOf("\n");
      shebang = newline < 0 ? stripped : stripped.slice(0, newline);
      stripped = dropOwnHeaders(newline < 0 ? "" : stripped.slice(newline + 1));
    }
    writeFileSync(file, `${shebang ? `${shebang}\n` : ""}${COMMENTABLE[ext]!(line)}\n${stripped}`);
  } else {
    writeFileSync(`${file}.prov.json`, JSON.stringify(prov, null, 1) + "\n");
  }
  process.stdout.write(`stamped ${basename(file)}  arm=${prov.arm} commit=${prov.commit.slice(0, 8)}\n`);
  return 0;
}

/** Record a figure -> file binding as you cite it, so the manifest is a
 *  byproduct of doing the work rather than a document written afterwards. */
function figure(): number {
  const name = process.argv[3], file = argValue("--file"), value = argValue("--value");
  if (!name || !file || !value) {
    process.stderr.write('stamp figure <name> --file <path> --value "<what it shows>"\n'); return 64;
  }
  if (!existsSync(file)) {
    process.stderr.write(`stamp figure: cites a file that does not exist: ${file}\n`); return 1;
  }
  const dir = resolve(file, "..");
  appendFileSync(join(dir, FIGURES), `${name}\t${value}\t${relative(dir, resolve(file))}\n`);
  process.stdout.write(`figure ${name} -> ${basename(file)}\n`);
  return 0;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (!n.endsWith(".prov.json") && n !== FIGURES) out.push(p);
  }
  return out;
}

/** The half that matters: name what has NO provenance, before a reader does. */
function manifest(): number {
  const dir = process.argv[3];
  if (!dir || !existsSync(dir)) { process.stderr.write(`stamp manifest: no such dir: ${dir}\n`); return 1; }
  const manifestFile = join(dir, "MANIFEST.md");
  const files = walk(dir).filter(file => file !== manifestFile).sort();
  const stamped: string[] = [], bare: string[] = [];
  for (const f of files) (provOf(f) ? stamped : bare).push(f);

  const figs = existsSync(join(dir, FIGURES))
    ? readFileSync(join(dir, FIGURES), "utf8").trim().split("\n").filter(Boolean) : [];

  const lines = [
    `# Evidence manifest — ${relative(process.cwd(), dir) || dir}`, "",
    `${files.length} artifacts · ${stamped.length} with provenance · **${bare.length} without**`, "",
    "## Figures", "",
    figs.length ? "| figure | shows | file |\n|---|---|---|" : "_none recorded — cite figures with `stamp figure` as you use them._",
    ...figs.map(l => { const [n, v, f] = l.split("\t"); return `| ${n} | ${v} | \`${f}\` |`; }), "",
    "## Artifacts with provenance", "",
    ...stamped.map(f => {
      const p = provOf(f)!;
      return `- \`${relative(dir, f)}\` — arm **${p.arm}**, commit \`${(p.commit ?? "").slice(0, 8)}\`` +
        (p.asset ? `, asset \`${p.asset}\`` : "");
    }), "",
  ];
  if (bare.length) {
    lines.push("## Artifacts WITHOUT provenance", "",
      "These cannot be tied to an arm or a commit. Any claim resting on one is",
      "unproven — stamp them or stop citing them.", "",
      ...bare.map(f => `- \`${relative(dir, f)}\``), "");
  }
  writeFileSync(manifestFile, lines.join("\n"));
  process.stdout.write(
    `${files.length} artifacts, ${stamped.length} stamped, ${bare.length} bare -> ${join(dir, "MANIFEST.md")}\n`);
  if (bare.length) process.stdout.write(`  unstamped:\n${bare.map(f => `    ${relative(dir, f)}`).join("\n")}\n`);
  return bare.length && process.argv.includes("--strict") ? 1 : 0;
}

const cmd = process.argv[2];
if (import.meta.main) {
  if (cmd === "write") process.exit(write());
  if (cmd === "figure") process.exit(figure());
  if (cmd === "manifest") process.exit(manifest());
  process.stderr.write([
    "usage: stamp.ts <command>",
    "  write    <file> --arm before|after --commit <sha> [--asset v=…] [--note …]",
    '  figure   <name> --file <path> --value "<what it shows>"',
    "  manifest <evidence-dir> [--strict]     # exit 1 if anything is unstamped",
    "",
  ].join("\n"));
  process.exit(64);
}
