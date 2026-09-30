/**
 * Whether a template body must be edited as HTML source rather than in the
 * formatted (TipTap StarterKit) editor, because the editor cannot represent it
 * and would rewrite it on the first keystroke.
 *
 * - Tables, <style>, and a full document (doctype/head): StarterKit has no node
 *   for them and drops them.
 * - A raw {{{ slot }}} directly inside a list, as in `<ul>{{{ memberRowsHtml }}}</ul>`.
 *   A list may only hold list items, so the editor wraps the slot text in an
 *   <li><p> of its own. The slot's pre-rendered <li> rows then nest under that
 *   extra item, and the email shows a stray bullet containing the real list.
 *   Every list-rendering template (clearance digests, onboarding reminder,
 *   attendance nudge, volunteers) uses this shape, because the template engine
 *   has no {{#each}}.
 */
export function isRichUnsafe(body: string, isLayout = false): boolean {
  if (isLayout) return true;
  if (/<table|<style|<!doctype|<head/i.test(body)) return true;
  return /<(ul|ol)\b[^>]*>\s*\{\{\{/i.test(body);
}
