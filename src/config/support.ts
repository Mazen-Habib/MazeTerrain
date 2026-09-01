/**
 * Voluntary contributions (OPEN-QUESTIONS Q2 — resolved "free + donations",
 * 2026-09-01).
 *
 * MazeTerrain is free. It has no accounts, no payments, no quota tracking and
 * no backend, and the decision to stay that way is what keeps Esri's
 * non-commercial imagery terms usable and keeps the architecture client-side.
 *
 * So this is a LINK and nothing more. The app never sees a card number, never
 * collects a billing detail, and never renders a payment form — the hosted
 * platform does all of that on its own domain. That is the entire reason this
 * approach costs nothing to secure: there is no payment surface here to attack.
 *
 * ## To turn it on
 *
 * Set `SUPPORT_URL` to the page's address. Until it is set the footer link does
 * not render at all, because a "Support this project" button that 404s is worse
 * than no button.
 *
 * The binding constraint on which platform is not the fee — it is whether the
 * platform can pay OUT to your country. Check that first, before making an
 * account anywhere. See the notes in `docs/01-project-overview.md#funding`.
 */
export const SUPPORT_URL: string | null = null;

/**
 * What the link says.
 *
 * Not "Donate": this is a tool someone is using, and the ask should read as an
 * offer rather than a toll. No modal, no interstitial, no nag after the third
 * export — one quiet link in the footer beside the attribution.
 */
export const SUPPORT_LABEL = 'Support this project';
