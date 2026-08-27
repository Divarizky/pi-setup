# Risk Register Template

Diisi per sesi `project-migration`, Step 4. Satu entry = satu kandidat deepening/area rawan.

## Entry Format

```
## <Module/Area Name>
**Files**: <daftar file terlibat>
**Problem**: <kenapa shallow / kenapa rawan break — 1-2 kalimat>
**Dependency type**: <pure computation | test stand-in tersedia | internal service | third-party>
**Seam status**: <ada seam nyata | seam hipotetis (1 adapter) | tidak ada seam>
**Risk level**: <low | medium | high>
**Migration order**: <urutan slice, angka>
```

## How to Set Risk Level

- **Low** — pure computation, ada test existing, tidak ada caller lain yang bergantung
- **Medium** — ada dependency I/O tapi ada stand-in, atau caller terbatas dan diketahui
- **High** — coupling tersembunyi, tidak ada seam sama sekali, atau caller tidak diketahui pasti (butuh eksplorasi lebih dulu)

## Migration Order

Kandidat risk rendah + dampak tinggi → migration_order kecil (dikerjakan duluan).
Kandidat risk tinggi → migration_order besar, atau tandai butuh eksplorasi tambahan sebelum masuk rencana.

## Notes

Entry dengan seam status "tidak ada seam" adalah temuan penting — bukan sekadar item, tapi sinyal bahwa arsitektur saat ini menghalangi migrasi aman. Bahas ini eksplisit sebelum masuk Step 3 (Migration Plan).
