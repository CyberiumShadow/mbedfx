import { readFileSync } from 'node:fs'
import { fillSiteTemplate, hostsOf } from '../../src/hosts.ts'

/**
 * THE OWNER'S DOMAINS AS TEST DATA, not read from wrangler.jsonc.
 *
 * Since the domains moved out of the code into `vars` (src/hosts.ts), the tests that pin how a guest
 * host, an unlisted host or the converter's buttons behave need SOME configuration, and they use this
 * fixed one rather than the live file on purpose: a deployment tracking this repo replaces the vars
 * with its own domains, and its build runs this same suite. Reading wrangler.jsonc here would fail
 * that build on every assertion that names the owner's guest hosts, for a config that is correct.
 *
 * The tests that check the CONFIG against itself (every route is refused, no guest is routed, the
 * spec's servers are routed) read wrangler.jsonc through wranglerConfig() below, and hold for any
 * deployment's values.
 */
export const OWNER_HOSTS = {
  HOSTS: 'mbedfx.app megapenispoopenfarten.sex',
  UNLISTED_HOSTS: 'forsen.sex',
  GUEST_HOSTS: 'sorryifuckedyour.mom hotsinglesnear.you',
}

export const GUEST_HOSTS = hostsOf(OWNER_HOSTS).guest

/** wrangler.jsonc parsed, with the `//`-stripping regex the other config tests use (line comments only). */
export const wranglerConfig = () => JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))

/** public/index.html as the owner's deployment serves it, placeholders filled. */
export const ownerPage = () =>
  fillSiteTemplate(readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8'), hostsOf(OWNER_HOSTS))
