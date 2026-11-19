// Web and image search with no API key.
//
// The Python library shipped with a Bing provider that required a key and a
// Null provider for offline use. A plugin that needs the user to obtain a key is
// not "install and it works", so the default here is a keyless HTML endpoint,
// with the keyed/offline providers kept as explicit options.
//
// Everything degrades rather than throws: a search that fails returns an empty
// result with a reason attached, because the local knowledge base is still a
// perfectly good answer and an exception would discard it.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export class WebResult {
  constructor({ title, url, snippet }) {
    this.title = title;
    this.url = url;
    this.snippet = snippet;
  }
}

export class ImageResult {
  constructor({ title, url, page, width = 0, height = 0 }) {
    this.title = title;
    this.url = url;
    this.page = page;
    this.width = width;
    this.height = height;
  }
}

/** Offline provider: always empty, never touches the network. */
export class NullProvider {
  async search() {
    return [];
  }
}

/**
 * Keyless web search over DuckDuckGo's HTML endpoint.
 *
 * Chosen because it needs no key and no account. It is HTML, so the parser is
 * deliberately loose: a result without a title or a URL is dropped rather than
 * guessed at, and a page that changed shape yields fewer results instead of
 * garbage.
 */
export class DuckDuckGoProvider {
  constructor({ endpoint = 'https://html.duckduckgo.com/html/', timeout = 12 } = {}) {
    this.endpoint = endpoint;
    this.timeout = timeout;
  }

  async search(query, { limit = 5 } = {}) {
    const res = await fetchWithTimeout(this.endpoint, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ q: query }).toString(),
      timeout: this.timeout,
    });
    const html = await res.text();
    return parseDdg(html).slice(0, limit);
  }
}

function parseDdg(html) {
  const out = [];
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));

  let m;
  let i = 0;
  while ((m = blockRe.exec(html))) {
    const url = decodeRedirect(m[1]);
    const title = stripTags(m[2]);
    if (!url || !title) continue;
    out.push(new WebResult({ title, url, snippet: snippets[i] ?? '' }));
    i += 1;
  }
  return out;
}

function decodeRedirect(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : u.toString();
  } catch {
    return '';
  }
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Keyless image search through the Wikimedia Commons API.
 *
 * Commons over Bing because it needs no key, and because the result objects
 * carry dimensions and a proper attribution page - which an answer that shows
 * pictures owes its reader.
 */
export class CommonsImages {
  constructor({ endpoint = 'https://commons.wikimedia.org/w/api.php', timeout = 12 } = {}) {
    this.endpoint = endpoint;
    this.timeout = timeout;
  }

  async search(query, { limit = 4 } = {}) {
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      generator: 'search',
      gsrsearch: `filetype:bitmap ${query}`,
      gsrnamespace: '6',
      gsrlimit: String(limit),
      prop: 'imageinfo',
      iiprop: 'url|size|extmetadata',
      iiurlwidth: '480',
    });
    const res = await fetchWithTimeout(`${this.endpoint}?${params}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      timeout: this.timeout,
    });
    const data = await res.json();
    const pages = data?.query?.pages ?? {};
    return Object.values(pages)
      .map((p) => {
        const info = p.imageinfo?.[0];
        if (!info) return null;
        return new ImageResult({
          title: p.title?.replace(/^File:/, '') ?? '',
          url: info.thumburl ?? info.url,
          page: info.descriptionurl ?? '',
          width: info.width ?? 0,
          height: info.height ?? 0,
        });
      })
      .filter(Boolean)
      .slice(0, limit);
  }
}

export class ImageSearch {
  constructor(provider = null, { offline = false } = {}) {
    this.provider = provider ?? (offline ? null : new CommonsImages());
  }

  async search(query, { limit = 4 } = {}) {
    if (!this.provider) return [];
    try {
      return await this.provider.search(query, { limit });
    } catch {
      return [];
    }
  }
}

export class WebSearch {
  constructor(provider = null, { offline = false, timeout = 12 } = {}) {
    this.provider = provider ?? (offline ? null : new DuckDuckGoProvider({ timeout }));
  }

  async search(query, { limit = 5 } = {}) {
    if (!this.provider) return [];
    try {
      return await this.provider.search(query, { limit });
    } catch {
      return [];
    }
  }
}

async function fetchWithTimeout(url, { timeout = 12, ...init } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}
