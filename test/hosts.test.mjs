import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apiServers, fillSiteTemplate, hostsOf, primaryHost, publicHosts, servedHosts } from '../src/hosts.ts'
import { handle } from '../src/worker.ts'
import { OWNER_HOSTS } from './fixtures/hosts.mjs'

/**
 * src/hosts.ts: the domains moved out of the code into wrangler.jsonc `vars`. These pin that the move
 * changed nothing for the owner's deployment, that a second deployment's page names only its own
 * domains, and that a value written into HTML cannot carry markup.
 */

const PAGE = readFileSync('public/index.html', 'utf8')
const ctx = { waitUntil() {} }
const deps = () => ({
  cache: { async match() {}, async put() {} },
  fetchPost: async () => null,
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})

test('THE OWNER\'S LISTS COME OUT EXACTLY AS THE PAGE HARDCODED THEM, order included', () => {
  /**
   * Before the move, public/index.html carried these three arrays as literals. Order matters: the
   * first PUBLIC_HOSTS entry is the pressed button and the fallback for an unknown host, so the
   * config has to rebuild them byte for byte or the owner's page changes under them.
   */
  const h = hostsOf(OWNER_HOSTS)
  assert.deepEqual(servedHosts(h), ['mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex', 'sorryifuckedyour.mom', 'hotsinglesnear.you'])
  assert.deepEqual(publicHosts(h), ['mbedfx.app', 'megapenispoopenfarten.sex', 'sorryifuckedyour.mom', 'hotsinglesnear.you'])
  assert.deepEqual(h.guest, ['sorryifuckedyour.mom', 'hotsinglesnear.you'])
  assert.equal(primaryHost(h), 'mbedfx.app')
})

test('a host belongs to one list only, so the page\'s nesting rules hold whatever the config says', () => {
  const h = hostsOf({ HOSTS: 'a.example', UNLISTED_HOSTS: 'a.example b.example', GUEST_HOSTS: 'b.example c.example a.example' })
  assert.deepEqual(h, { listed: ['a.example'], unlisted: ['b.example'], guest: ['c.example'] })
})

test('A NAME THAT IS NOT A HOSTNAME IS DROPPED, because these strings are written into HTML and a script', () => {
  /**
   * fillSiteTemplate inserts each name unescaped, into an attribute, a text node and a JS array. That
   * is safe only because nothing but [a-z0-9.-] survives this parse. A value that could close a tag or
   * a string would be a stored XSS on the front page, written by whoever edits the config.
   */
  const h = hostsOf({ HOSTS: 'ok.example "><script>x</script> evil".example single bad_label.example https://origin.example/path' })
  assert.deepEqual(h.listed, ['ok.example', 'origin.example'])
  const page = fillSiteTemplate('<b>{{mbedfx:host}}</b>{{mbedfx:host-buttons}}<script>var A = {{mbedfx:our-hosts}};</script>', h)
  assert.doesNotMatch(page, /<script>x|evil"/)
})

test('A SECOND DEPLOYMENT\'S PAGE NAMES ONLY ITS OWN DOMAIN: every placeholder filled, no owner host left in the markup', () => {
  /**
   * The reason for the move. A deployment that sets HOSTS to its domain and nothing else must serve a
   * page whose meta tags, buttons, help copy and script lists all say that domain. Comments are
   * stripped before the check: they describe the owner's history, ship in view-source, and are not
   * the page saying anything.
   */
  const page = fillSiteTemplate(PAGE, hostsOf({ HOSTS: 'ietai.ga' }))
  assert.doesNotMatch(page, /\{\{mbedfx:/, 'every placeholder is filled')
  const code = page.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const owner of ['mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex', 'sorryifuckedyour.mom', 'hotsinglesnear.you']) {
    assert.ok(!code.includes(owner), `${owner} is still in the served page outside a comment`)
  }
  assert.match(page, /<meta property="og:url" content="https:\/\/ietai\.ga\/">/)
  assert.match(page, /var OUR_HOSTS = \["ietai\.ga"\];/)
  assert.match(page, /var GUEST_HOSTS = \[\];/)
  assert.deepEqual([...page.matchAll(/data-host="([^"]+)"/g)].map(m => m[1]), ['ietai.ga'], 'one button, for the one domain')
})

test('with no HOSTS at all the page names the host it was asked on, and never invents a real-looking one', () => {
  // A bare `wrangler dev` or a self-hosted run with no vars. `localhost` is one label and fails the
  // hostname check, so it becomes `.invalid` rather than a guess.
  assert.match(fillSiteTemplate('{{mbedfx:host}}', hostsOf({}), 'embed.example.com'), /^embed\.example\.com$/)
  assert.equal(fillSiteTemplate('{{mbedfx:host}}', hostsOf({}), 'localhost'), 'localhost.invalid')
  assert.deepEqual(apiServers(hostsOf({}), 'localhost').map(s => s.url), ['https://localhost.invalid'])
})

test('THE WORKER SERVES THE FILLED PAGE, and drops the etag that described the unfilled file', async () => {
  /**
   * A conditional request passed straight to ASSETS would get a 304 for the template's etag, and the
   * visitor's cached copy of another deployment's (or an older config's) page would stand. So the
   * template is asked for with a plain GET, and the answer carries no etag or length of its own.
   */
  let forwarded = null
  const ASSETS = {
    async fetch(req) {
      forwarded = req
      return new Response(PAGE, { headers: { 'content-type': 'text/html', etag: '"abc"', 'content-length': String(PAGE.length) } })
    },
  }
  const env = { AE: { writeDataPoint() {} }, ASSETS, TRANSLATE_GOOGLE: 'off', HOSTS: 'ietai.ga' }
  const res = await handle(new Request('https://ietai.ga/', { headers: { 'if-none-match': '"abc"' } }), env, ctx, deps())
  assert.equal(res.status, 200)
  assert.equal(forwarded.headers.get('if-none-match'), null, 'the template is never asked for conditionally')
  assert.equal(res.headers.get('etag'), null)
  assert.equal(res.headers.get('content-length'), null)
  const html = await res.text()
  assert.match(html, /og:url" content="https:\/\/ietai\.ga\/"/)
  assert.doesNotMatch(html, /\{\{mbedfx:/)

  // Every other site file is the binding's answer, untouched.
  const robots = await handle(new Request('https://ietai.ga/robots.txt'), {
    ...env, ASSETS: { async fetch() { return new Response('User-agent: *\n', { headers: { etag: '"r"' } }) } },
  }, ctx, deps())
  assert.equal(robots.headers.get('etag'), '"r"')
})

test('the owner\'s deployment still refuses its guest hosts\' front door, now from config', async () => {
  // The guest gate reads GUEST_HOSTS from env; with the owner's vars, `/` on a guest host is declined
  // before ASSETS is touched, exactly as when the list was a constant.
  const env = { AE: { writeDataPoint() {} }, ASSETS: { async fetch() { throw new Error('ASSETS must not be reached') } }, ...OWNER_HOSTS }
  const res = await handle(new Request('https://hotsinglesnear.you/'), env, ctx, deps())
  assert.equal(res.status, 404)
})
