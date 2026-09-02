/**
 * "Support me" (OPEN-QUESTIONS Q2 — free, 2026-09-01).
 *
 * Peakora is free. No accounts, no payments, no quota tracking, no backend —
 * which is what keeps Esri's non-commercial imagery terms usable and keeps the
 * architecture entirely client-side.
 *
 * **No donation platform.** The owner decided against one on 2026-09-02: every
 * candidate turned on whether it could pay out to their country, and none of
 * that is worth solving to run a link. This points at their own page instead,
 * which costs nothing, needs no account anywhere, and can be repointed at a
 * funding platform later by changing one string.
 *
 * The app therefore has no payment surface at all — it never sees a card
 * number, never collects a billing detail, never renders a form. That is not a
 * security measure that had to be designed; it is a consequence of the link
 * being a link.
 */

/** Where "Support me" goes. Null hides the link entirely. */
export const SUPPORT_URL: string | null = 'https://www.instagram.com/peakpkofficial';

/**
 * What the link says.
 *
 * Not "Donate", which asks for money the page does not take. One quiet link in
 * the footer beside the attribution: no modal, no interstitial, no nag after
 * the third export. A tool that begs is a tool people stop opening.
 */
export const SUPPORT_LABEL = 'Support me';
