/**
 * Copy text to the clipboard, with the fallback that is not optional here.
 *
 * `navigator.clipboard` is undefined outside a secure context, and local
 * development runs on plain http://localhost -- so a bare `writeText` throws on
 * every dev machine and would look like a broken feature rather than a missing
 * browser capability. `document.execCommand('copy')` is deprecated but is still
 * the only thing that works there, and it needs a real selected element, hence
 * the throwaway textarea.
 *
 * Returns whether the copy actually happened, so a caller can decline to claim
 * success. Never throws: a failed copy is a UI state, not an error path.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy path rather than giving up -- this branch is
    // the common one in development, not an edge case.
  }

  try {
    const el = document.createElement('textarea');
    el.value = text;
    // Off-screen rather than hidden: `display:none` and `visibility:hidden`
    // elements cannot hold a selection, so the copy would silently no-op.
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.top = '-1000px';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
