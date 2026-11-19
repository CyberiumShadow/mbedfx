/**
 * THE DOMAINS THIS DEPLOYMENT ANSWERS ON, read from wrangler.jsonc `vars` rather than written into
 * the code. Pure: no I/O, total over any input.
 *
 * WHY CONFIG AND NOT A CONSTANT. The owner's domains used to be literals in four places
 * (fedihost.ts's OWN_HOSTS, guesthost.ts's GUEST_HOSTS, the converter page's three lists, the smoke
 * origin) plus the page's meta tags and copy. A second deployment that tracks this repo then had to
 * carry a diff against every one of those lines, and every upstream edit near them became a merge
 * conflict. Now a deployment states its domain LISTS once, beside the `routes` that claim them. Other
 * mentions remain and are not lists: comments and docs describing the owner's history, the Reddit
 * User-Agents (src/platforms/reddit/fetch.ts), the .github health scripts, and test fixture data.
 *
 * THREE LISTS, because the page draws three distinctions and each one is somebody's decision:
 *
 *   HOSTS           Served through this Worker's own `routes` AND offered as a domain button, in
 *                   button order. THE FIRST IS THE PRIMARY: the page's og:url, its fallback for a
 *                   visitor on an unknown host, and the origin the scheduled smoke check uses.
 *   UNLISTED_HOSTS  Served through `routes`, recognised by the converter, never offered (the owner's
 *                   forsen.sex). Not secret, just not handed out.
 *   GUEST_HOSTS     Another Worker's domains that reach this one through a service binding
 *                   (src/guesthost.ts). Offered, and NEVER in `routes`.
 *
 * Whitespace- or comma-separated, bare hostname or origin, the same parse as OWN_HOSTS.
 *
 * EVERY NAME IS VALIDATED AS A HOSTNAME and anything else is dropped, because these strings are
 * written into HTML and into a script block (fillSiteTemplate). A value that is only letters, digits,
 * dots and hyphens cannot close a tag or a string literal. Do not loosen HOSTNAME to admit a port or
 * a path without escaping at every insertion point first.
 */

export interface HostsEnv {
  HOSTS?: string
  UNLISTED_HOSTS?: string
  GUEST_HOSTS?: string
}

export interface Hosts {
  listed: string[]
  unlisted: string[]
  guest: string[]
}

/** Lowercase labels, at least two of them, nothing but [a-z0-9-] inside each. See the header. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

/**
 * `a.example, https://b.example` -> ['a.example', 'b.example']. Total: junk contributes nothing.
 * Unvalidated, which is right for OWN_HOSTS (an extra name there can only make the SSRF guard
 * stricter) and wrong for anything rendered; hostList below adds the check.
 */
export function declaredHosts(list?: string): string[] {
  if (!list) return []
  const out: string[] = []
  for (const raw of list.split(/[\s,]+/)) {
    if (!raw) continue
    const t = raw.trim().toLowerCase().replace(/\.$/, '')
    if (t.includes('/') || t.includes('@')) {
      try {
        out.push(new URL(t.includes('//') ? t : `https://${t}`).hostname.replace(/\.$/, ''))
      } catch {
        // Unparseable: contributes nothing. It cannot ADMIT a host, so ignoring it is safe.
      }
    } else {
      out.push(t.replace(/^\./, ''))
    }
  }
  return out.filter(Boolean)
}

/** declaredHosts, validated and de-duplicated, order kept. */
function hostList(list?: string): string[] {
  return [...new Set(declaredHosts(list).filter(h => HOSTNAME.test(h)))]
}

/**
 * The three lists. A name claimed by an earlier list is dropped from a later one, so one host has
 * one role: the page's nesting invariants (PUBLIC within OUR, GUEST within OUR) hold by construction
 * rather than by an operator getting three strings right.
 */
export function hostsOf(env?: HostsEnv): Hosts {
  const listed = hostList(env?.HOSTS)
  const unlisted = hostList(env?.UNLISTED_HOSTS).filter(h => !listed.includes(h))
  const guest = hostList(env?.GUEST_HOSTS).filter(h => !listed.includes(h) && !unlisted.includes(h))
  return { listed, unlisted, guest }
}

/** Every host this Worker answers on, by route or by binding: the page's OUR_HOSTS, in its order. */
export function servedHosts(h: Hosts): string[] {
  return [...h.listed, ...h.unlisted, ...h.guest]
}

/** The hosts the converter offers as buttons: the page's PUBLIC_HOSTS, in button order. */
export function publicHosts(h: Hosts): string[] {
  return [...h.listed, ...h.guest]
}

/** The primary domain, or null when the deployment names none (a bare `wrangler dev`). */
export function primaryHost(h: Hosts): string | null {
  return h.listed[0] ?? null
}

/**
 * THE CONVERTER PAGE AND THE SPEC, FILLED IN at serve time (worker.ts, the `site` route). The files
 * in public/ carry `{{mbedfx:…}}` placeholders where a domain goes, so the same file is correct on
 * every deployment and names none of them.
 *
 * SERVER-SIDE, NOT IN THE BROWSER, for two reasons. og:url and og:image are read by crawlers, which
 * run no script. And the page's own rule is never to take its domain from location.hostname: that
 * was tried and reverted (baff668) because d.{host} read as a domain of its own and media only
 * composed d.d.{host}. The lists below are the explicit answer that rule asks for.
 *
 * `fallback` is the request's own hostname, used only when the deployment names no host at all, so
 * a bare `wrangler dev` still draws a page whose links point back at itself. It goes through the
 * same HOSTNAME check; `localhost` fails it (one label), and the page then says `localhost.invalid`
 * rather than guessing a real-looking domain.
 */
export function fillSiteTemplate(text: string, h: Hosts, fallback?: string): string {
  const primary = primaryHost(h) ?? (fallback && HOSTNAME.test(fallback) ? fallback : 'localhost.invalid')
  const ours = servedHosts(h)
  const pub = publicHosts(h)
  // With no HOSTS, the fallback leads both lists, so the page's first button and its default agree.
  const our = h.listed.length ? ours : [primary, ...ours]
  const offered = h.listed.length ? pub : [primary, ...pub]
  const buttons = offered
    .map((host, i) => `<button type="button" data-host="${host}" aria-pressed="${i === 0}">${host}</button>`)
    .join('\n                ')
  return text
    .replaceAll('{{mbedfx:our-hosts}}', JSON.stringify(our))
    .replaceAll('{{mbedfx:public-hosts}}', JSON.stringify(offered))
    .replaceAll('{{mbedfx:guest-hosts}}', JSON.stringify(h.guest))
    .replaceAll('{{mbedfx:host-buttons}}', buttons)
    .replaceAll('{{mbedfx:host}}', primary)
}

/**
 * openapi.json's `servers`: every domain that answers the API. Guest hosts are left out because they
 * decline `api` (guesthost.ts guestServes), so a client pointed at one would get the other site's
 * page. The spec's examples carry `{{mbedfx:host}}` and are filled by fillSiteTemplate.
 */
export function apiServers(h: Hosts, fallback?: string): { url: string; description: string }[] {
  const hosts = [...h.listed, ...h.unlisted]
  if (!hosts.length) {
    const primary = fallback && HOSTNAME.test(fallback) ? fallback : 'localhost.invalid'
    return [{ url: `https://${primary}`, description: 'This deployment.' }]
  }
  return hosts.map((host, i) => ({
    url: `https://${host}`,
    description: i === 0 ? 'This deployment\'s primary domain.' : 'Another domain serving the same worker.',
  }))
}
