/**
 * Personality profile SURFACING opt-in switch.
 *
 * Facets are always TRACKED in the background (Path A `ckn-extract` + Path B
 * `ckn-observe-facets` keep extracting), so a user's personality is already
 * populated the moment they opt in. `CKN_PROFILE` gates only whether the
 * profile is SURFACED — injected into the capability sheet, the `/cortex-profile-setup`
 * onboarding nudge, and the dashboard's Profile UI. Default OFF. Accepts
 * `1`/`on`/`true`/`yes` (case-insensitive). Documented in the README; single
 * source of truth the hooks, capability sheet, and API import.
 */
export const profileEnabled = (): boolean => {
  const v = (process.env.CKN_PROFILE ?? '').trim().toLowerCase()
  return v === '1' || v === 'on' || v === 'true' || v === 'yes'
}
