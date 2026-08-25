# Risk Register Template

Diisi per sesi `project-migration`, Step 2. Satu entry = satu kandidat deepening/area rawan.

## Format Entry

```
## <Nama modul/area>
**Files**: <daftar file terlibat>
**Problem**: <kenapa shallow / kenapa rawan break — 1-2 kalimat>
**Dependency type**: <pure computation | test stand-in tersedia | internal service | third-party>
**Seam status**: <ada seam nyata | seam hipotetis (1 adapter) | tidak ada seam>
**Risk level**: <low | medium | high>
**Migration order**: <urutan slice, angka>
```

## Cara Isi Risk Level

- **Low** — pure computation, ada test existing, tidak ada caller lain yang bergantung
- **Medium** — ada dependency I/O tapi ada stand-in, atau caller terbatas dan diketahui
- **High** — coupling tersembunyi, tidak ada seam sama sekali, atau caller tidak diketahui pasti (butuh eksplorasi lebih dulu)

## Urutan Migration

Kandidat risk rendah + dampak tinggi → migration_order kecil (dikerjakan duluan).
Kandidat risk tinggi → migration_order besar, atau tandai butuh eksplorasi tambahan sebelum masuk rencana.

## Catatan

Entry dengan seam status "tidak ada seam" adalah temuan penting — bukan sekadar item, tapi sinyal bahwa arsitektur saat ini menghalangi migrasi aman. Bahas ini eksplisit sebelum masuk Step 3 (Migration Plan).
