import { refText, type PrRef } from "./decision-ledger.ts";
import type { Run } from "./pr-ci.ts";
import { diffSize, type DiffSize } from "./proof-checkout.ts";
import { finishedReviews, summaryGaps, type GapProof, type ProofIdentity, type ProofSummary } from "./proof.ts";

type Sized = DiffSize & { commit: string };
export type Growth = { rounds: number; finalReads: number; first?: Sized; final?: Sized };
export type EndRow = { ref: PrRef; summary: ProofSummary; reason: (kind: string, reason: string) => string };

const isRound = (name: string) => /^\d+$/.test(name);

function sizeAt(identity: ProofIdentity, run: Run, baseSha: string | undefined): Sized | undefined {
  const size = diffSize(identity, run, baseSha);
  return size && { ...size, commit: identity.commit };
}

export async function measureGrowth(home: string, head: ProofIdentity, run: Run, baseSha?: string): Promise<Growth | undefined> {
  const reviews = await finishedReviews(home, head);
  const rounds = reviews.filter(({ name }) => isRound(name)).sort((a, b) => Number(a.name) - Number(b.name));
  if (!rounds.length) return undefined;
  const first = sizeAt({ ...head, commit: rounds[0]!.commit }, run, baseSha);
  const final = sizeAt(head, run, baseSha);
  return { rounds: rounds.length, finalReads: reviews.length - rounds.length, ...first ? { first } : {}, ...final ? { final } : {} };
}

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const figure = (lines: number | undefined) => lines === undefined ? "unknown" : lines.toLocaleString("en-US");
const span = (from: number | undefined, to: number | undefined) => `${figure(from)} → ${figure(to)}`;

function roundsCell(growth: Growth | undefined) {
  if (!growth) return "no review";
  return [counted(growth.rounds, "round"), ...growth.finalReads ? [counted(growth.finalReads, "final read")] : []].join(", ");
}

function linesCell(growth: Growth | undefined) {
  if (!growth) return "not measured";
  const { first, final } = growth;
  const ratio = first && final && first.production > 0 ? ` (×${(final.production / first.production).toFixed(1)})` : "";
  const apart = (["tests", "docs"] as const).filter((part) => first?.[part] || final?.[part]).map((part) => `${part} ${span(first?.[part], final?.[part])}`);
  return [`${span(first?.production, final?.production)}${ratio}`, ...apart].join("; ");
}

function acceptor(gap: GapProof) {
  const by = gap.accepted;
  if (!by) return "not accepted";
  if (by.by === "standing rule") return "a standing rule";
  return [by.mark, by.by, by.id].filter(Boolean).join(" ");
}

const skipped = ({ summary, reason }: EndRow) =>
  summaryGaps(summary).map(({ kind, gap }) => `${kind}: ${gap.reason ? reason(kind, gap.reason) : "no reason recorded"} (${acceptor(gap)})`);

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function endTable(rows: EndRow[]) {
  return [
    "| PR | Review rounds | Production lines | Skipped proofs |", "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${[refText(row.ref), roundsCell(row.summary.growth), linesCell(row.summary.growth), skipped(row).join("; ") || "none"].map(cell).join(" | ")} |`),
  ];
}
