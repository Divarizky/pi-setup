/**
 * footer-chain.ts — composite fleet + footer custom pihak ketiga.
 *
 * Protokol: pemilik footer custom (ui-customization) publish factory-nya di
 * `globalThis[CUSTOM_FOOTER_CHAIN_KEY]` dan emit `CUSTOM_FOOTER_CHAIN_EVENT`
 * untuk observability. Fleet membaca registry itu tiap `update()` dan memasang SATU `setFooter`
 * berisi footer custom di atas + baris fleet di bawahnya. Saat fleet kosong
 * atau dispose, factory custom asli dikembalikan — slot footer tidak pernah
 * hilang dan tidak pernah tertimpa.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "./agent-widget.js";
import type { FleetList } from "./fleet-list.js";

export const CUSTOM_FOOTER_CHAIN_KEY = "__piCustomFooterFactory";
export const CUSTOM_FOOTER_CHAIN_EVENT = "ui-customization:footer";

export type FooterFactory = (
  tui: any,
  theme: Theme,
  footerData: any,
) => { render(width: number): string[]; invalidate(): void; dispose?(): void };

/** Factory custom terakhir yang dipublish pemilik footer. */
export function readChainedFooter(): FooterFactory | undefined {
  const f = (globalThis as any)[CUSTOM_FOOTER_CHAIN_KEY];
  return typeof f === "function" ? (f as FooterFactory) : undefined;
}

/**
 * Pasang composite fleet + footer custom. Kembalikan fungsi restore yang
 * mengembalikan factory custom asli (atau undefined = footer bawaan bila
 * tidak ada custom).
 */
export function mountChainedFooter(
  setFooter: (f: FooterFactory | undefined) => void,
  fleet: FleetList,
): () => void {
  const custom = readChainedFooter();
  if (!custom) {
    // Tidak ada footer custom: fleet tetap tampil sendiri; restore = footer bawaan.
    setFooter((tui, theme) => ({
      render: (w: number) => {
        fleet.setTui(tui);
        return fleet.renderFleetLines(w, theme);
      },
      invalidate: () => {},
    }));
    return () => setFooter(undefined);
  }
  const chained: FooterFactory = (tui, theme, footerData) => {
    fleet.setTui(tui);
    const inner = custom(tui, theme, footerData);
    return {
      render: (w: number) => {
        const fleetLines = fleet.renderFleetLines(w, theme);
        const customLines = inner.render(w);
        const joined = fleetLines.length === 0 ? customLines : [...customLines, "", ...fleetLines];
        return joined.map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
      },
      invalidate: () => inner.invalidate(),
      dispose: () => inner.dispose?.(),
    };
  };
  setFooter(chained);
  // Restore ke factory custom ASLI (bukan undefined) agar footer custom hidup lagi.
  // Factory dipanggil ulang oleh pi saat setFooter — instance baru, tidak double-dispose.
  return () => setFooter(custom);
}
