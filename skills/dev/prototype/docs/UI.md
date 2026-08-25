# UI Prototype

Generate **beberapa varian UI yang radically berbeda** di satu screen/route/view, switchable via state (bukan URL). User flip antar varian, pilih satu (atau ambil potongan dari tiap varian), sisanya throwaway.

Framework-agnostic. Contoh mapping:

| Konsep | Flutter | SwiftUI | Compose | React/Vue |
|---|---|---|---|---|
| State varian | `ValueNotifier` / `setState` | `@State` | `mutableStateOf` | `useState` / `ref` |
| Switcher overlay | `Stack` + `Positioned` | `ZStack` + overlay | `Box` + `Modifier.offset` | `position: fixed` bottom |
| Debug gate | `kDebugMode` | `#if DEBUG` | `BuildConfig.DEBUG` | `process.env.NODE_ENV` |

Jangan terjebak framework-specific — tulis switcher component sekali, pakai di mana aja.

## Kapan ini bentuk yang tepat

- "Gimana kalo halaman ini layoutnya beda?"
- "Mau liat beberapa opsi dashboard sebelum milih."
- "Coba tata letak lain buat setting screen."
- Kapanpun user bakal habiskan sehari milih antara 3 mockup vague di kepala.

## Dua sub-shape — prefer A

UI prototype jauh lebih gampang dinilai kalo **nempel di app beneran** — real header, real sidebar, real density. Route throwaway sendiri itu vacuum: tiap varian keliatan oke diisolasi.

### Sub-shape A — adjustment ke existing screen (preferred)

Route/screen udah ada. Varian di-render **di route yang sama**, diganti via state (`variant = 'A'`). Data fetching, params, auth — semua tetap. Cuma rendering yang swap. Pilih ini kecuali ada alasan spesifik gak bisa.

Kalo prototype buat sesuatu yang belum punya page tapi *naturalnya ada di dalam page existing* (section baru di dashboard, card baru di settings, step baru di flow existing) — itu masih sub-shape A. Mount variants di dalam host page.

### Sub-shape B — screen baru (last resort)

Cuma kalo yang diprototype beneran gak punya existing page — misal surface top-level baru, atau flow yang gak bisa di-embed mana pun.

Buat **throwaway route/view** ikut routing convention yang project pake. Jangan invent struktur top-level baru. Nama route mengandung `prototype`. Sama: switching via state, bukan URL.

Sebelum commit ke B, sanity check: beneran gak ada existing page yang bisa ditempelin? Empty route nyembunyiin masalah desain.

## Proses

### 1. Tulis question dan pilih N

Default **3 varian**. Lebih dari 5 berhenti jadi "radically different" dan mulai jadi noise — cap di situ.

Tulis satu baris di lokasi prototype atau komentar:

```
// Tiga varian settings page, switchable via state, di route /settings yang existing
```

Bisa dicek kalo user ada buat push back atau gak.

### 2. Generate varian radically berbeda

Draft tiap varian. Pegang:

- Purpose page + data yang tersedia.
- Component library / styling system project (Tailwind, shadcn, MUI, Material, Cupertino, plain CSS — whatever).
- Nama component ekspor jelas: `VariantA`, `VariantB`, `VariantC`.

Varian harus **structurally berbeda** — layout beda, informasi hierarchy beda, primary affordance beda, bukan cuma warna beda. Tiga card grid yang sedikit di-tweak bukan UI prototype. Kalo dua draft terlalu mirip, ulang satu dengan guidance "jangan pake card grid."

### 3. Wire bersama

Buat satu switcher component:

```pseudo
// pseudo-code — adapt ke framework project
state = { currentVariant: 'A' }

render:
  if currentVariant == 'A' -> VariantA(data)
  if currentVariant == 'B' -> VariantB(data)
  if currentVariant == 'C' -> VariantC(data)
  -> PrototypeSwitcher(currentVariant, onSwitch)
```

**Sub-shape A** (existing screen): semua data fetching di atas switcher. Hanya rendered subtree yang beda per varian.

**Sub-shape B** (screen baru): throwaway route mount switcher yang sama.

### 4. Floating switcher

Component kecil fixed di bottom-center screen:

- **Arrow kiri** — prev variant (wrap around).
- **Label** — current variant key + nama kalo ada: `B — Sidebar layout`.
- **Arrow kanan** — next variant (wrap around).

Behavior:

- Klik arrow update state variant.
- Keyboard juga: `←` dan `→` arrow keys cycle variant. Jangan intercept kalo `<input>`, `<textarea>`, atau `[contenteditable]` sedang focus.
- Visually distinct dari page (high-contrast pill, subtle shadow) — jelas bukan bagian dari design yang dievaluasi.
- **Hidden di production/debug build** — gate di `kDebugMode` / `#if DEBUG` / `BuildConfig.DEBUG` / `NODE_ENV !== 'production'`. Jangan sampai merge stray prototype ke user.

Buat switcher sekali di shared component, reuse di semua UI prototype. Letakkan di folder shared UI project.

### 5. Hand over

Surface informasi: "Ada 3 varian, flip pake arrow atau keyboard kiri/kanan." User flip kapan aja. Feedback menarik biasanya "gw mau header dari B dengan sidebar dari C" — itu design yang mereka mau.

### 6. Capture answer dan cleanup

Setelah satu varian menang:

- **Sub-shape A** — fold winner ke existing screen. Drop losing variants + switcher dari main.
- **Sub-shape B** — promote winner ke real route. Drop throwaway route + switcher dari main.

Full set variants = primary source → throwaway branch, bukan bin. Varian + switcher yang tertinggal di main branch cepet basi dan bingungin pembaca selanjutnya.

Tulis decision di `.workspace/.scratch/<slug>/prototype-decision.md` sesuai format [SKILL.md](SKILL.md).

## Anti-patterns

- **Varian beda warna doang.** Itu tweak, bukan prototype. Varian beneran beda struktur.
- **Terlalu banyak shared code antar varian.** `<Header>` shared fine; shared `<Layout>` defeats the point. Tiap varian boleh buang layout.
- **Wire variants ke real mutations.** Read-only prototype fine. Kalo varian butuh mutate, pake stub — questionnya "gimana keliatannya", bukan "backend jalan gak".
- **Promote langsung ke production.** Varian ditulis tanpa test, error handling minimal. Tulis ulang proper pas fold ke real code.
