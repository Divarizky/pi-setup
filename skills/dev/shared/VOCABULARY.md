# Vocabulary

Definisi shared yang dipakai lintas skill. Satu sumber kebenaran — skill lain refer
ke sini, jangan redefine.

## Architecture

- **Module** — unit kode: interface (kontrak publik) + implementation (isi di baliknya).
- **Interface** — semua yang caller wajib tahu buat pakai module. Bukan detail internal.
- **Depth** — rasio behavior vs interface. Deep = interface kecil, behavior besar di baliknya.
  Shallow = interface hampir sekompleks implementasi.
- **Seam** — titik kode tempat behavior bisa diganti tanpa edit langsung di situ.
- **Adapter** — implementasi konkret di balik seam. Satu adapter = hipotetis. Dua adapter = nyata.
- **Locality** — hal yang berhubungan (perubahan, bug, pengetahuan) tetap berdekatan lokasinya,
  tidak tersebar.
- **Vertical Slice** (tracer bullet) — satu jalur sempit tembus SEMUA layer (UI, logic, data).
  Bisa langsung di-demo begitu selesai. Lawan: horizontal slice (satu layer saja).
- **Seam Types**:
  - **Good seam** — isolate komponen bug dari dependencies. Test hanya butuh mock interface kecil.
  - **Bad/Shallow seam** — test harus mock banyak dependency atau hanya test surface behavior.
    Bug di logic bisa lolos test surface ini.
- **Prefactoring** — perubahan kecil sebelum implementasi fitur (max 2 perubahan):
  rename method/variable, extract function ≤10 baris, inline trivial wrapper.

## ADR Filter

Keputusan dicatat sebagai ADR **hanya** kalau lolos ketiga filter ini:

1. **Hard to reverse** — biaya ubah nanti tinggi.
2. **Surprising without context** — orang lain baca kode nanti tanya "kenapa begini?"
3. **Real trade-off** — ada alternatif nyata yang sengaja tidak dipilih.

Kalau salah satu tidak terpenuhi → skip, tidak perlu ADR.
