import type { MatchRange, Violation } from "./types.ts";

export interface StripTarget {
  range?: MatchRange;
  match?: string;
}

/**
 * Menghapus rentang pelanggaran dari teks tanpa merusak teks di sekitarnya.
 * Menggabungkan rentang yang tumpang tindih dan memotong teks dari belakang ke depan
 * agar pergeseran indeks tidak merusak rentang lain.
 */
export function stripViolations(
  text: string,
  matches: Array<Violation | StripTarget>,
): string {
  if (!text || !matches || matches.length === 0) {
    return text;
  }

  // Ekstrak dan validasi semua rentang target
  const ranges: MatchRange[] = [];

  for (const m of matches) {
    if (m.range && typeof m.range.start === "number" && typeof m.range.end === "number") {
      let { start, end } = m.range;
      if (start < 0) start = 0;
      if (end > text.length) end = text.length;

      // Verifikasi apakah potongan pada range cocok dengan match jika ada
      if (m.match && text.slice(start, end) !== m.match) {
        // Jika offset bergeser, coba cari kemunculan string match
        const foundIdx = text.indexOf(m.match, Math.max(0, start - 50));
        if (foundIdx !== -1) {
          start = foundIdx;
          end = foundIdx + m.match.length;
        }
      }

      if (start < end) {
        ranges.push({ start, end });
      }
    } else if (m.match && typeof m.match === "string") {
      let searchIdx = 0;
      while (searchIdx < text.length) {
        const found = text.indexOf(m.match, searchIdx);
        if (found === -1) break;
        ranges.push({ start: found, end: found + m.match.length });
        searchIdx = found + m.match.length;
      }
    }
  }

  if (ranges.length === 0) {
    return text;
  }

  // Urutkan range dari awal ke akhir
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  // Gabungkan rentang yang tumpang tindih atau berdekatan
  const merged: MatchRange[] = [];
  let current = { ...ranges[0] };

  for (let i = 1; i < ranges.length; i++) {
    const next = ranges[i];
    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  // Potong teks berdasarkan rentang yang sudah digabung
  let result = "";
  let lastIndex = 0;

  for (const r of merged) {
    result += text.slice(lastIndex, r.start);
    lastIndex = r.end;
  }
  result += text.slice(lastIndex);

  // Bila penghapusan terjadi di paling awal teks dan meninggalkan spasi pemisah berlebih,
  // rapikan spasi/baris baru awal agar sisa teks menjadi awal yang wajar.
  if (merged[0].start === 0 && text.startsWith(text.slice(0, merged[0].end))) {
    // Jika sisa teks diawali spasi tunggal setelah kalimat yang dipotong, buang spasi itu
    if (result.startsWith(" ") && !result.startsWith("  ")) {
      result = result.slice(1);
    }
  }

  return result;
}
